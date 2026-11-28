import crypto from 'node:crypto';
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
import {
  adjustBrightnessContrast,
  applyFilter,
  composite,
  deserializeProject,
  getPixel,
  serializeProject
} from './imageCore.js';
import { encodePng } from './imageCodec.js';
import { ImageProjectGenerator } from './imageProjectGenerator.js';
import type { ImageProject, RgbaColor } from './types.js';

/**
 * Factory Phase F8 — the Image Editors workflow.
 *
 * A described image editor flows through the factory machinery as
 * one workflow (the F7 games workflow is the pattern):
 *
 *   description → team by data        (F5: CategoryTeamRegistry)
 *               → swarm build         (F2–F4 chain; the build's tree
 *                                      is the editor project package:
 *                                      a serialized ImageProject, the
 *                                      generated editor app's
 *                                      manifest, package tests)
 *               → environment cycle   (F6 contract, web adapter)
 *               → engine verification (this module: the delivered
 *                                      project is loaded by the real
 *                                      engine, round-tripped, and an
 *                                      operation chain is executed
 *                                      with pixel-exact assertions)
 *
 * The PixelForge-class editor application itself is produced by the
 * platform's own generator (`generateEditorApp`, Phases 19/44–60);
 * its genuine compile evidence is those phases' PE-verified dotnet
 * builds. What this workflow verifies is the delivered editor
 * *project*: that the engine loads it losslessly and that real
 * engine operations on it produce exactly the pixels the engine's
 * documented math predicts.
 */
export interface ImageEditorWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface ImageWorkflowCycle {
  projectId: string;
  environment: 'web';
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  files: Array<{ path: string; content: string }>;
}

export interface ImageProjectCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ImageProjectVerification {
  verified: boolean;
  checks: ImageProjectCheck[];
  /** SHA-256 of the delivered project's composite, PNG-encoded. */
  compositeSha256?: string;
  /** SHA-256 of the composite after the verification operation chain. */
  chainedCompositeSha256?: string;
}

/**
 * The workflow's verification operation chain, applied to the
 * delivered project's "Base" layer: brightness +20 (contrast 0, so
 * the Phase 19 factor is exactly 1), then the Phase 47 saturation
 * filter at amount 0.5. Both are the engine's own entry points; the
 * expected pixels in the F8 suite are hand-computed from the same
 * documented formulas.
 */
export const IMAGE_WORKFLOW_CHAIN = {
  layerName: 'Base',
  brightness: 20,
  contrast: 0,
  saturationFilter: 'saturation',
  saturationAmount: 0.5
} as const;

export class ImageEditorWorkflow {
  /** Step 1: resolve the creative team from the F5 registry data. */
  static plan(description: string): ImageEditorWorkflowPlan {
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

  /**
   * The PixelForge-class editor application for this workflow,
   * produced by the platform's own generator (Phases 19/44–60). The
   * workflow asserts the generated file set; the app's genuine
   * compile evidence is those phases' PE-verified builds.
   */
  static generateEditorApp(appName = 'PixelForge'): Record<string, string> {
    return ImageProjectGenerator.generateProjectFiles(ImageProjectGenerator.getDefaultConfig(appName));
  }

  /** The F6 environment cycle for a built editor project package. */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<ImageWorkflowCycle> {
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
   * The category verification gate for a delivered image-editor
   * project (the parsed content of project/image-project.json):
   *
   *  1. the engine deserializes it;
   *  2. serialize → deserialize → composite is byte-identical to the
   *     delivered composite (lossless project round trip);
   *  3. the delivered composite's pixels are read back exactly;
   *  4. the workflow operation chain (IMAGE_WORKFLOW_CHAIN) executes
   *     through the engine's own adjustment/filter entry points and
   *     the composited result is pixel-checked — the caller asserts
   *     the exact expected values for its fixture.
   *
   * Returns the report plus the before/after composites so the
   * caller can make its pixel assertions; a project the engine
   * refuses, or one without the chain's "Base" layer, is reported
   * not verified with the reason named — never thrown past the gate.
   */
  static verifyProject(delivered: unknown): {
    verification: ImageProjectVerification;
    before?: ReturnType<typeof composite>;
    after?: ReturnType<typeof composite>;
    project?: ImageProject;
  } {
    const checks: ImageProjectCheck[] = [];
    const check = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
    };

    let project: ImageProject;
    try {
      project = deserializeProject(delivered as any);
      check(
        'engine deserializes the delivered project',
        true,
        `${project.width}x${project.height}, ${project.layers.length} layers (${project.layers.map((l) => l.name).join(', ')})`
      );
    } catch (e: any) {
      check('engine deserializes the delivered project', false, e?.message || String(e));
      return { verification: { verified: false, checks } };
    }

    const before = composite(project);
    const compositeSha256 = crypto.createHash('sha256').update(encodePng(before)).digest('hex');

    try {
      const roundTripped = deserializeProject(serializeProject(project));
      const roundTripPng = encodePng(composite(roundTripped));
      const identical = roundTripPng.equals(encodePng(before));
      check(
        'project round-trips losslessly (serialize → deserialize → composite byte-identical)',
        identical,
        identical ? `composite PNG sha256 ${compositeSha256}` : 'round-tripped composite differs from the delivered composite'
      );
      if (!identical) {
        return { verification: { verified: false, checks, compositeSha256 }, before, project };
      }
    } catch (e: any) {
      check('project round-trips losslessly', false, e?.message || String(e));
      return { verification: { verified: false, checks, compositeSha256 }, before, project };
    }

    const base = project.layers.find((l) => l.name === IMAGE_WORKFLOW_CHAIN.layerName);
    if (!base) {
      check(
        'operation chain target layer present',
        false,
        `the delivered project has no layer named "${IMAGE_WORKFLOW_CHAIN.layerName}" (${project.layers.map((l) => l.name).join(', ')})`
      );
      return { verification: { verified: false, checks, compositeSha256 }, before, project };
    }
    check('operation chain target layer present', true, `layer "${base.name}" (${base.id})`);

    adjustBrightnessContrast(project, base.id, IMAGE_WORKFLOW_CHAIN.brightness, IMAGE_WORKFLOW_CHAIN.contrast);
    applyFilter(project, base.id, IMAGE_WORKFLOW_CHAIN.saturationFilter, { amount: IMAGE_WORKFLOW_CHAIN.saturationAmount });
    const after = composite(project);
    const chainedCompositeSha256 = crypto.createHash('sha256').update(encodePng(after)).digest('hex');
    check(
      'operation chain executes through the engine (brightness/contrast adjustment + saturation filter)',
      chainedCompositeSha256 !== compositeSha256,
      `composite sha256 ${compositeSha256.slice(0, 12)}… → ${chainedCompositeSha256.slice(0, 12)}…`
    );

    return {
      verification: { verified: checks.every((c) => c.passed), checks, compositeSha256, chainedCompositeSha256 },
      before,
      after,
      project
    };
  }

  /** Reads one composited pixel — the assertion surface for callers. */
  static pixel(image: ReturnType<typeof composite>, x: number, y: number): RgbaColor {
    return getPixel(image, x, y);
  }
}
