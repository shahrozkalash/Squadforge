import crypto from 'node:crypto';
import {
  detectFormat,
  exportImage,
  importImage,
  importImageWithMetadata,
  type ImageFormat
} from './imageCodec.js';
import {
  applyDevelopSettings,
  resolveDevelopSettings,
  type DevelopSettings,
  type DevelopSettingsInput
} from './photoDevelop.js';
import type { PixelImage } from './types.js';

/**
 * Factory Phase F8 — the photo project: catalog + non-destructive
 * develop + batch export, on the image engine.
 *
 * A photo project is a *catalog*: an ordered list of photo entries,
 * each recording the original file's identity (name, format as
 * detected by content, dimensions, byte size, SHA-256 of the
 * original bytes), its organize data (star rating, pick/reject
 * flag), and its develop settings (photoDevelop.ts — data, never
 * baked into pixels). The original bytes themselves are NOT stored
 * in the project and are never modified by anything in this module:
 * developing decodes a caller-supplied copy, verifies its SHA-256
 * against the catalog entry (a tampered or swapped original is
 * refused by name), applies the settings, and exports new bytes.
 *
 * Supported originals are exactly the formats the engine's codecs
 * genuinely decode — PNG, JPEG, BMP, TIFF — detected by content, not
 * extension. Camera RAW files (.cr2/.cr3/.nef/.arw/.dng/.rw2/.orf/
 * .pef) are refused with a named error: this engine has no RAW
 * decoder, and pretending otherwise would be a fake feature. PSD is
 * refused too — it is a layered project format, not a photo original
 * for this workflow.
 *
 * Batch export follows the Phase 53 honesty pattern: every photo is
 * attempted in catalog order, each result records its own outcome,
 * and one photo's failure never aborts or disguises the others.
 */

export type PhotoFlag = 'none' | 'pick' | 'reject';

export interface PhotoCatalogEntry {
  id: string;
  fileName: string;
  format: ImageFormat;
  width: number;
  height: number;
  byteSize: number;
  /** SHA-256 (hex) of the original file bytes, recorded at import. */
  sha256: string;
  /** Star rating 0..5 (organize data). */
  rating: number;
  flag: PhotoFlag;
  /** Non-destructive develop settings — data only, never baked in. */
  develop: DevelopSettings;
}

export interface PhotoProject {
  format: 'squadforge-photo-project';
  version: 1;
  name: string;
  photos: PhotoCatalogEntry[];
}

export const RAW_FILE_EXTENSIONS = ['.cr2', '.cr3', '.nef', '.arw', '.dng', '.rw2', '.orf', '.pef'];

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function createPhotoProject(name: string): PhotoProject {
  if (!name || !name.trim()) throw new Error('Photo project name must not be empty');
  return { format: 'squadforge-photo-project', version: 1, name, photos: [] };
}

export function getPhoto(project: PhotoProject, photoId: string): PhotoCatalogEntry {
  const entry = project.photos.find((p) => p.id === photoId);
  if (!entry) throw new Error(`Photo not found in catalog: ${photoId}`);
  return entry;
}

/**
 * Imports a photo into the catalog: the bytes are decoded by the
 * engine (so a catalog entry only ever names a photo this platform
 * can actually develop), the format is detected by content, and the
 * original's SHA-256 is recorded. The bytes are not retained and
 * never modified.
 */
export function importPhoto(project: PhotoProject, fileName: string, bytes: Buffer): PhotoCatalogEntry {
  if (!fileName || !fileName.trim()) throw new Error('Photo file name must not be empty');
  const lower = fileName.toLowerCase();
  const rawExt = RAW_FILE_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (rawExt) {
    throw new Error(
      `RAW camera files are not supported ("${fileName}"): this engine has no RAW decoder. ` +
        'Export a JPEG, TIFF or PNG from your RAW converter and import that instead — RAW support is not claimed.'
    );
  }
  if (project.photos.some((p) => p.fileName === fileName)) {
    throw new Error(`Photo catalog already contains a file named "${fileName}"`);
  }
  const detected = detectFormat(bytes);
  if (detected === 'psd') {
    throw new Error(
      `"${fileName}" is a PSD: a layered project file, not a photo original for the photo workflow. ` +
        'Import it through the image editor (importPsd) instead.'
    );
  }
  // Throws the codec's named error for unrecognized/corrupt data.
  const { metadata } = importImageWithMetadata(bytes);
  const entry: PhotoCatalogEntry = {
    id: crypto.randomUUID(),
    fileName,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    byteSize: bytes.length,
    sha256: sha256Hex(bytes),
    rating: 0,
    flag: 'none',
    develop: resolveDevelopSettings()
  };
  project.photos.push(entry);
  return entry;
}

export function setPhotoRating(project: PhotoProject, photoId: string, rating: number): void {
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    throw new Error(`Photo rating must be an integer in the range [0, 5] (got ${rating})`);
  }
  getPhoto(project, photoId).rating = rating;
}

export function setPhotoFlag(project: PhotoProject, photoId: string, flag: PhotoFlag): void {
  if (flag !== 'none' && flag !== 'pick' && flag !== 'reject') {
    throw new Error(`Photo flag must be one of none/pick/reject (got ${String(flag)})`);
  }
  getPhoto(project, photoId).flag = flag;
}

/**
 * Edits a photo's develop settings as data: the patch is merged over
 * the current settings (per HSL channel, per field) and the merged
 * result is validated and stored. No pixel is touched — the change
 * takes effect the next time the photo is developed/exported, and
 * the original file is unaffected, as always.
 */
export function updatePhotoDevelop(
  project: PhotoProject,
  photoId: string,
  patch: DevelopSettingsInput
): DevelopSettings {
  const entry = getPhoto(project, photoId);
  const merged: DevelopSettingsInput = { ...entry.develop, ...patch };
  if (patch.hsl !== undefined) {
    const hsl: NonNullable<DevelopSettingsInput['hsl']> = {};
    for (const channel of Object.keys(entry.develop.hsl) as Array<keyof DevelopSettings['hsl']>) {
      hsl[channel] = { ...entry.develop.hsl[channel], ...(patch.hsl[channel] ?? {}) };
    }
    merged.hsl = hsl;
  }
  entry.develop = resolveDevelopSettings(merged);
  return entry.develop;
}

/** True when the supplied bytes are the catalogued original (hash match). */
export function verifyPhotoSource(entry: PhotoCatalogEntry, sourceBytes: Buffer): boolean {
  return sha256Hex(sourceBytes) === entry.sha256;
}

/**
 * Develops one photo: verifies the source bytes are the catalogued
 * original (SHA-256), decodes them with the engine, and applies the
 * entry's develop settings. Returns a new image; the source bytes
 * and the catalog are untouched.
 */
export function developPhoto(project: PhotoProject, photoId: string, sourceBytes: Buffer): PixelImage {
  const entry = getPhoto(project, photoId);
  if (!verifyPhotoSource(entry, sourceBytes)) {
    throw new Error(
      `Source bytes for "${entry.fileName}" do not match the catalogued original (SHA-256 mismatch) — ` +
        'the file was modified or swapped after import; refusing to develop it under this catalog entry.'
    );
  }
  return applyDevelopSettings(importImage(sourceBytes), entry.develop);
}

/** Develops and encodes one photo to the requested export format. */
export function exportDevelopedPhoto(
  project: PhotoProject,
  photoId: string,
  sourceBytes: Buffer,
  format: ImageFormat,
  options?: { jpegQuality?: number }
): Buffer {
  const developed = developPhoto(project, photoId, sourceBytes);
  return exportImage(developed, format, options);
}

export interface PhotoExportResult {
  photoId: string;
  fileName: string;
  status: 'exported' | 'failed';
  format?: ImageFormat;
  byteSize?: number;
  /** SHA-256 (hex) of the exported bytes, when exported. */
  sha256?: string;
  error?: string;
}

/**
 * Batch export: develops and encodes every photo in catalog order.
 * `getSource` supplies the current original bytes per entry (or null
 * when unavailable). Each photo's outcome is recorded individually;
 * a missing source, a hash mismatch, or a codec failure fails that
 * photo only — the batch continues and reports honestly.
 */
export function batchExportPhotos(
  project: PhotoProject,
  getSource: (entry: PhotoCatalogEntry) => Buffer | null,
  options: { format: ImageFormat; jpegQuality?: number }
): PhotoExportResult[] {
  const results: PhotoExportResult[] = [];
  for (const entry of project.photos) {
    try {
      const source = getSource(entry);
      if (source === null) {
        throw new Error(`Source bytes unavailable for "${entry.fileName}"`);
      }
      const bytes = exportDevelopedPhoto(project, entry.id, source, options.format, options);
      results.push({
        photoId: entry.id,
        fileName: entry.fileName,
        status: 'exported',
        format: options.format,
        byteSize: bytes.length,
        sha256: sha256Hex(bytes)
      });
    } catch (e: any) {
      results.push({ photoId: entry.id, fileName: entry.fileName, status: 'failed', error: e?.message || String(e) });
    }
  }
  return results;
}

// ------------------------------------------------------------ persistence

/** Serializes the catalog to plain JSON data (a detached deep copy). */
export function serializePhotoProject(project: PhotoProject): PhotoProject {
  return JSON.parse(JSON.stringify(project)) as PhotoProject;
}

/**
 * Loads a catalog from parsed JSON data, validating every field —
 * including re-resolving every entry's develop settings through the
 * strict validator, so corrupt settings are rejected at load, never
 * discovered mid-export.
 */
export function deserializePhotoProject(data: unknown): PhotoProject {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Not a SquadForge photo project (expected an object)');
  }
  const raw = data as Record<string, unknown>;
  if (raw.format !== 'squadforge-photo-project' || raw.version !== 1) {
    throw new Error('Not a SquadForge photo project (bad format/version)');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error('Invalid photo project: name must be a non-empty string');
  }
  if (!Array.isArray(raw.photos)) {
    throw new Error('Invalid photo project: photos must be an array');
  }
  const project = createPhotoProject(raw.name);
  const seenNames = new Set<string>();
  for (const rawEntry of raw.photos as Array<Record<string, unknown>>) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new Error('Invalid photo project: catalog entries must be objects');
    }
    const fileName = rawEntry.fileName;
    if (typeof fileName !== 'string' || !fileName.trim()) {
      throw new Error('Invalid photo project: every catalog entry needs a fileName');
    }
    if (seenNames.has(fileName)) {
      throw new Error(`Invalid photo project: duplicate catalog file name "${fileName}"`);
    }
    seenNames.add(fileName);
    const format = rawEntry.format;
    if (format !== 'png' && format !== 'jpeg' && format !== 'bmp' && format !== 'tiff') {
      throw new Error(`Invalid photo project: photo "${fileName}" has unsupported format ${String(format)}`);
    }
    const { width, height, byteSize, rating } = rawEntry as Record<string, unknown>;
    if (!Number.isInteger(width) || (width as number) <= 0 || !Number.isInteger(height) || (height as number) <= 0) {
      throw new Error(`Invalid photo project: photo "${fileName}" has invalid dimensions`);
    }
    if (!Number.isInteger(byteSize) || (byteSize as number) <= 0) {
      throw new Error(`Invalid photo project: photo "${fileName}" has an invalid byteSize`);
    }
    if (typeof rawEntry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawEntry.sha256)) {
      throw new Error(`Invalid photo project: photo "${fileName}" has an invalid sha256`);
    }
    if (!Number.isInteger(rating) || (rating as number) < 0 || (rating as number) > 5) {
      throw new Error(`Invalid photo project: photo "${fileName}" has an invalid rating`);
    }
    const flag = rawEntry.flag;
    if (flag !== 'none' && flag !== 'pick' && flag !== 'reject') {
      throw new Error(`Invalid photo project: photo "${fileName}" has an invalid flag`);
    }
    if (typeof rawEntry.id !== 'string' || !rawEntry.id) {
      throw new Error(`Invalid photo project: photo "${fileName}" has an invalid id`);
    }
    project.photos.push({
      id: rawEntry.id,
      fileName,
      format,
      width: width as number,
      height: height as number,
      byteSize: byteSize as number,
      sha256: rawEntry.sha256,
      rating: rating as number,
      flag,
      develop: resolveDevelopSettings(rawEntry.develop as DevelopSettingsInput)
    });
  }
  return project;
}
