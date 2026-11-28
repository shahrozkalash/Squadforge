import type {
  CanonicalProjectType,
  CategoryTeamDefinition,
  ResolvedCategoryTeam
} from '../types.js';
import { CategoryTeamRegistry } from '../swarm/categoryTeams.js';
import { createEnvironment } from '../environment/index.js';
import type {
  EnvironmentArtifact,
  EnvironmentBuildResult,
  EnvironmentTestResult
} from '../environment/index.js';
import { importImage } from './imageCodec.js';
import {
  batchExportPhotos,
  deserializePhotoProject,
  developPhoto,
  exportDevelopedPhoto,
  sha256Hex,
  verifyPhotoSource,
  type PhotoProject
} from './photoProject.js';
import type { PixelImage } from './types.js';

/**
 * Factory Phase F8 — the Photo Editors workflow.
 *
 * A described photo editor flows through the factory machinery as
 * one workflow (the F7 games workflow is the pattern):
 *
 *   description → team by data        (F5: CategoryTeamRegistry)
 *               → swarm build         (F2–F4 chain; the build's tree
 *                                      is the photo project package:
 *                                      the catalog photo-project.json
 *                                      with develop settings as data,
 *                                      plus the package's own tests)
 *               → environment cycle   (F6 contract, web adapter)
 *               → delivery verification (this module: the catalog is
 *                                      checked against the real
 *                                      original bytes by SHA-256,
 *                                      every photo is developed by
 *                                      the F8 develop engine, a batch
 *                                      export runs, and the originals
 *                                      are proven untouched)
 *
 * The photo workflow's engine — catalog + non-destructive develop +
 * batch export — is the F8 build itself (photoProject.ts +
 * photoDevelop.ts on the image engine), because the redesign audit
 * found no Lightroom-class engine in the platform. Its honest scope
 * is stated there: PNG/JPEG/BMP/TIFF originals, no RAW, develop =
 * global adjustments as data.
 */
export interface PhotoEditorWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface PhotoWorkflowCycle {
  projectId: string;
  environment: 'web';
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  files: Array<{ path: string; content: string }>;
}

export interface PhotoDeliveryCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PhotoDeliveryPhoto {
  photoId: string;
  fileName: string;
  /** SHA-256 of the original bytes, before and after the whole run. */
  sourceSha256Before: string;
  sourceSha256After: string;
  meanLuminanceBefore: number;
  meanLuminanceAfter: number;
  exportedByteSize?: number;
  exportedSha256?: string;
}

export interface PhotoDeliveryVerification {
  verified: boolean;
  checks: PhotoDeliveryCheck[];
  photos: PhotoDeliveryPhoto[];
}

/** Mean Rec.601 luminance (0..255) of an image — the develop evidence metric. */
export function meanLuminance(img: PixelImage): number {
  let sum = 0;
  const pixels = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return sum / pixels;
}

/** Mean of each RGB channel (0..255) — the white-balance evidence metric. */
export function meanChannels(img: PixelImage): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

export class PhotoEditorWorkflow {
  /** Step 1: resolve the creative team from the F5 registry data. */
  static plan(description: string): PhotoEditorWorkflowPlan {
    const team = CategoryTeamRegistry.selectForRequest(description);
    const resolvedTeam = CategoryTeamRegistry.resolve(team);
    return {
      description,
      category: team.category,
      teamName: team.displayName,
      profileId: team.profileId,
      team,
      resolvedTeam
    };
  }

  /** The F6 environment cycle for a built photo project package. */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<PhotoWorkflowCycle> {
    const env = createEnvironment('web', { userId: input.userId });
    await env.openProject({ projectId: input.projectId, title: input.title });

    const build = await env.build(input.projectId);
    const tests = await env.runTests(input.projectId);
    const preview = await env.preview(input.projectId);
    const exported = await env.exportArtifact(input.projectId);

    const files: Array<{ path: string; content: string }> = [];
    for (const filePath of await env.listFiles(input.projectId)) {
      const content = await env.readFile(input.projectId, filePath);
      if (content !== null) files.push({ path: filePath, content });
    }

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      files
    };
  }

  /**
   * The category verification gate for a delivered photo project.
   *
   * `deliveredProject` is the parsed photo-project.json from the
   * delivered package; `sources` maps each catalogued file name to
   * the current original bytes. The gate:
   *
   *  1. deserializes the catalog through the strict validator;
   *  2. verifies every catalogued original by SHA-256 (a swapped or
   *     edited original fails the delivery by name);
   *  3. develops every photo with its catalogued settings and runs a
   *     real batch export (JPEG) — every photo must export, and each
   *     export must decode back at the original's dimensions;
   *  4. re-hashes every original afterwards: the originals are
   *     byte-identical before and after the whole delivery, which is
   *     what "non-destructive" means, proven rather than asserted.
   */
  static verifyDelivery(input: {
    deliveredProject: unknown;
    sources: Map<string, Buffer>;
  }): PhotoDeliveryVerification {
    const checks: PhotoDeliveryCheck[] = [];
    const photos: PhotoDeliveryPhoto[] = [];
    const check = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
    };

    let project: PhotoProject;
    try {
      project = deserializePhotoProject(input.deliveredProject);
      check('catalog deserializes and validates', true, `${project.photos.length} photos in "${project.name}"`);
    } catch (e: any) {
      check('catalog deserializes and validates', false, e?.message || String(e));
      return { verified: false, checks, photos };
    }

    const hashesBefore = new Map<string, string>();
    let allSourcesOk = true;
    for (const entry of project.photos) {
      const source = input.sources.get(entry.fileName);
      if (!source) {
        check(`original present: ${entry.fileName}`, false, 'no source bytes supplied for this catalog entry');
        allSourcesOk = false;
        continue;
      }
      hashesBefore.set(entry.fileName, sha256Hex(source));
      const ok = verifyPhotoSource(entry, source);
      if (!ok) allSourcesOk = false;
      check(
        `original verified by SHA-256: ${entry.fileName}`,
        ok,
        ok ? `${entry.format} ${entry.width}x${entry.height}, ${entry.byteSize} bytes` : 'source bytes do not match the catalogued hash'
      );
    }
    if (!allSourcesOk) return { verified: false, checks, photos };

    const exports = batchExportPhotos(project, (entry) => input.sources.get(entry.fileName) ?? null, {
      format: 'jpeg',
      jpegQuality: 92
    });
    for (const result of exports) {
      const entry = project.photos.find((p) => p.id === result.photoId)!;
      const source = input.sources.get(entry.fileName)!;
      if (result.status !== 'exported') {
        check(`batch export: ${entry.fileName}`, false, result.error || 'export failed');
        continue;
      }
      // The export must be a real, decodable image of the developed
      // photo at the original's dimensions. The develop pipeline is
      // deterministic, so a direct export of the same photo must be
      // byte-identical to the batch result — decode that and compare
      // hashes, which validates the batch bytes themselves.
      const developed = developPhoto(project, entry.id, source);
      const directBytes = exportDevelopedPhoto(project, entry.id, source, 'jpeg', { jpegQuality: 92 });
      const decoded = importImage(directBytes);
      const dimsOk = decoded.width === entry.width && decoded.height === entry.height;
      const hashOk = sha256Hex(directBytes) === result.sha256;
      photos.push({
        photoId: entry.id,
        fileName: entry.fileName,
        sourceSha256Before: hashesBefore.get(entry.fileName)!,
        sourceSha256After: sha256Hex(source),
        meanLuminanceBefore: meanLuminance(importImage(source)),
        meanLuminanceAfter: meanLuminance(developed),
        exportedByteSize: result.byteSize,
        exportedSha256: result.sha256
      });
      check(
        `batch export: ${entry.fileName}`,
        result.byteSize !== undefined && result.byteSize > 0 && dimsOk && hashOk,
        `${result.byteSize} bytes JPEG, sha256 ${result.sha256?.slice(0, 12)}…; ` +
          `decodes at ${decoded.width}x${decoded.height} (catalogued ${entry.width}x${entry.height}); ` +
          `direct export byte-identical to batch: ${hashOk}`
      );
    }

    const originalsUntouched = project.photos.every((entry) => {
      const source = input.sources.get(entry.fileName);
      return source !== undefined && sha256Hex(source) === hashesBefore.get(entry.fileName);
    });
    check(
      'originals byte-identical after develop + batch export (non-destructive)',
      originalsUntouched,
      originalsUntouched ? 'every original re-hashes to its pre-run SHA-256' : 'an original changed during the run'
    );

    return { verified: checks.every((c) => c.passed), checks, photos };
  }
}
