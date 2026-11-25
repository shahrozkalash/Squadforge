import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase 24: game asset management — a manifest of the assets a game
 * project ships (sprites, sounds, scenes), with existence/type
 * validation and content hashes so missing or swapped assets are
 * caught before a build, not at runtime.
 */

export type AssetKind = 'sprite' | 'sound' | 'scene' | 'font' | 'data';

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  path: string; // project-relative
  sha256?: string;
  sizeBytes?: number;
}

export interface AssetValidation {
  valid: boolean;
  problems: string[];
  checked: number;
}

const KIND_EXTENSIONS: Record<AssetKind, string[]> = {
  sprite: ['.png', '.bmp', '.jpg', '.jpeg'],
  sound: ['.wav', '.mp3', '.ogg'],
  scene: ['.json'],
  font: ['.ttf', '.otf'],
  data: ['.json', '.txt', '.csv']
};

export class AssetManager {
  private entries = new Map<string, AssetEntry>();

  public register(entry: AssetEntry): void {
    if (this.entries.has(entry.id)) throw new Error(`Duplicate asset id: ${entry.id}`);
    const ext = path.extname(entry.path).toLowerCase();
    if (!KIND_EXTENSIONS[entry.kind].includes(ext)) {
      throw new Error(`Asset ${entry.id}: extension ${ext} is not valid for kind ${entry.kind}`);
    }
    this.entries.set(entry.id, entry);
  }

  public get(id: string): AssetEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown asset: ${id}`);
    return entry;
  }

  public list(): AssetEntry[] {
    return [...this.entries.values()];
  }

  /** Verify every registered asset exists in the project and (when recorded) matches its hash. */
  public validate(projectRoot: string): AssetValidation {
    const problems: string[] = [];
    let checked = 0;
    for (const entry of this.entries.values()) {
      checked++;
      const abs = path.join(projectRoot, entry.path);
      if (!fs.existsSync(abs)) {
        problems.push(`${entry.id}: missing file ${entry.path}`);
        continue;
      }
      const data = fs.readFileSync(abs);
      entry.sizeBytes = data.length;
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (entry.sha256 && entry.sha256 !== hash) {
        problems.push(`${entry.id}: hash mismatch for ${entry.path}`);
      }
      entry.sha256 = hash;
    }
    return { valid: problems.length === 0, problems, checked };
  }

  public toManifest(): { assets: AssetEntry[] } {
    return { assets: this.list() };
  }
}
