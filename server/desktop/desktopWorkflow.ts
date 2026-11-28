import * as fs from 'fs';
import type {
  CanonicalProjectType,
  CategoryTeamDefinition,
  ResolvedCategoryTeam
} from '../types.js';
import { db } from '../store.js';
import { CategoryTeamRegistry } from '../swarm/categoryTeams.js';
import { createEnvironment } from '../environment/index.js';
import type {
  EnvironmentArtifact,
  EnvironmentBuildResult,
  EnvironmentDeploymentValidation,
  EnvironmentTestResult
} from '../environment/index.js';
import { DesktopProjectGenerator } from './desktopProjectGenerator.js';
import { ElfInspector } from './elfInspector.js';
import {
  assessDesktopDelivery,
  verifyWindowsPackage,
  type DesktopGateReport
} from './desktopProjectGate.js';

/**
 * Factory Phase F11 — the Desktop workflow.
 *
 * One described desktop application flows through the factory
 * machinery as a single workflow, using only the surfaces the
 * earlier Factory phases established (the F7/F9/F10 pattern):
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the Desktop
 *                            Software Team and the desktop_application
 *                            profile are selected, never hardcoded
 *                            here)
 *     → swarm build         (F2–F4 chain: planner → dependency-ordered
 *                            tasks → parallel workers → sandbox gate →
 *                            verifier → integration → honest
 *                            verification; driven by the caller via
 *                            SwarmOrchestrator, the platform's build
 *                            entry point — the delivered tree is the
 *                            platform's generated Avalonia project)
 *     → environment cycle   (F6: the built project is opened through
 *                            the DESKTOP environment contract — the
 *                            first Arc D workflow to use the desktop
 *                            adapter — and built / smoke-tested /
 *                            exported / deployment-dry-run through
 *                            contract operations only)
 *     → desktop gate        (F11: server/desktop/desktopProjectGate —
 *                            pipeline build verdict, two consecutive
 *                            --smoke runs with strictly increasing
 *                            persisted LaunchCount, the exported
 *                            apphost re-verified as ELF from disk,
 *                            the deployment dry-run, and the Windows
 *                            release package produced by the Phase 23
 *                            release system: genuine dotnet publish,
 *                            PE-verified exe, SHA-256 manifest,
 *                            validatePackage, tamper detection)
 *     → verified delivery   (the gate, whole: every check green)
 *
 * Claim discipline, stated once and held everywhere: the Linux
 * apphost is genuinely built and genuinely launched headlessly
 * (--smoke is the generated app's own state-store exercise; the
 * GUI itself has never been run — no display exists here, Phases
 * 36/57 record). The Windows exe is publish- and package-verified
 * only; it cannot execute on this host. macOS remains honestly
 * rejected by the generator until a macOS generator lands.
 */
export interface DesktopWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface DesktopWorkflowDelivery {
  projectId: string;
  environment: 'desktop';
  build: EnvironmentBuildResult;
  smokeRuns: EnvironmentTestResult[];
  /** Persisted LaunchCount reported by each smoke run, in order. */
  launchCounts: number[];
  artifact: EnvironmentArtifact;
  deploymentDryRun: EnvironmentDeploymentValidation;
  gate: DesktopGateReport;
  /** True only when every gate check passed. */
  verified: boolean;
}

export class DesktopWorkflow {
  /**
   * Step 1 of the workflow: resolve the desktop team for a
   * description from the F5 registry data. Throws
   * CategoryTeamResolutionError on dangling data — a request never
   * silently falls back to a default team.
   */
  static plan(description: string): DesktopWorkflowPlan {
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
   * The delivery verdict, factored out so it can be asserted
   * directly: a desktop delivery is verified only when the gate
   * passed in full — pipeline build, persistent smoke runs, ELF
   * artifact, deployment dry-run, and the Windows release package
   * with tamper detection.
   */
  static verifyDelivery(input: { gate: DesktopGateReport }): boolean {
    return input.gate.passed === true;
  }

  /**
   * Steps 3–4 of the workflow: take the swarm build's delivered
   * tree from the platform store and drive it through the F6
   * desktop environment contract — open (seeded with the delivered
   * files), build, two smoke runs, export, deployment dry-run —
   * then produce the Windows release package for the same app
   * identity through the Phase 23 release system and apply the
   * desktop gate.
   *
   * The environment's project config is derived from the title by
   * the adapter (Linux/Avalonia on this host), so the title must be
   * the app name the delivered project was generated for.
   */
  static async runEnvironmentCycle(input: {
    buildId: string;
    title: string;
    workspaceRoot: string;
    artifactsRoot: string;
    windowsScratchRoot: string;
  }): Promise<DesktopWorkflowDelivery> {
    const deliveredFiles = db
      .getAllFiles(input.buildId)
      .map(f => ({ path: f.path, content: f.content }));

    const env = createEnvironment('desktop', {
      workspaceRoot: input.workspaceRoot,
      artifactsRoot: input.artifactsRoot
    });
    await env.openProject({
      projectId: input.buildId,
      title: input.title,
      files: deliveredFiles
    });

    const build = await env.build(input.buildId);

    const smokeRuns: EnvironmentTestResult[] = [];
    const launchCounts: number[] = [];
    if (build.status === 'succeeded') {
      for (let i = 0; i < 2; i++) {
        const run = await env.runTests(input.buildId);
        smokeRuns.push(run);
        const match = /LaunchCount=(\d+)/.exec(run.detail);
        if (match) launchCounts.push(Number(match[1]));
      }
    }

    let artifact: EnvironmentArtifact = {
      name: 'none',
      kind: 'executable',
      sizeBytes: 0
    };
    let artifactElfOk = false;
    if (build.status === 'succeeded') {
      const exported = await env.exportArtifact(input.buildId);
      artifact = exported.artifact;
      if (artifact.path && fs.existsSync(artifact.path)) {
        artifactElfOk = ElfInspector.inspect(fs.readFileSync(artifact.path)).isElfFile;
      }
    }

    const deploymentDryRun = await env.validateDeployment(input.buildId);

    // The Windows half of the delivery: the same app identity,
    // generated for Windows by the platform's own generator and
    // packaged by its release system (Phase 23).
    const assemblyName =
      input.title.replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z]+/, '') || 'FactoryApp';
    const windowsConfig = DesktopProjectGenerator.getDefaultConfig(input.title, assemblyName);
    const windowsFiles = DesktopProjectGenerator.generateProjectFiles(windowsConfig);
    const windowsPackage = await verifyWindowsPackage({
      windowsFiles,
      metadata: {
        appName: input.title,
        version: windowsConfig.version,
        publisher: windowsConfig.company,
        description: windowsConfig.description,
        channel: 'stable',
        selfContained: false,
        releaseNotes: `${input.title} ${windowsConfig.version} — packaged by the SquadForge Factory F11 desktop workflow.`
      },
      scratchRoot: input.windowsScratchRoot
    });

    const gate = assessDesktopDelivery({
      build,
      smokeRuns,
      launchCounts,
      artifact,
      artifactElfOk,
      deploymentDryRun,
      windowsPackage
    });

    return {
      projectId: input.buildId,
      environment: 'desktop',
      build,
      smokeRuns,
      launchCounts,
      artifact,
      deploymentDryRun,
      gate,
      verified: this.verifyDelivery({ gate })
    };
  }
}
