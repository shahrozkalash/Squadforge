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
import type { IosProjectConfig } from '../ios/types.js';
import {
  verifyAndroidProject,
  verifyIosProject,
  type AndroidGateReport,
  type IosGateReport,
  type MobileProjectFileInput
} from './mobileProjectGate.js';

/**
 * Factory Phase F10 — the Mobile workflow (Android / iOS).
 *
 * One described mobile app flows through the factory machinery as a
 * single workflow, using only the surfaces the earlier Factory
 * phases established (the F7/F9 pattern):
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the Mobile
 *                            Development Team and the
 *                            android_mobile_application profile are
 *                            selected, never hardcoded here)
 *     → swarm build         (F2–F4 chain: planner → dependency-ordered
 *                            tasks → parallel workers → sandbox gate →
 *                            verifier → integration → honest
 *                            verification; driven by the caller via
 *                            SwarmOrchestrator, the platform's build
 *                            entry point)
 *     → environment cycle   (F6: the built project is opened through
 *                            the one FactoryEnvironment contract — web
 *                            adapter — and built / tested / previewed
 *                            / exported through contract operations
 *                            only; the outcomes are surfaced exactly
 *                            as the adapter reports them: a native
 *                            Android tree has no web bundle entry
 *                            point and no JS test suite, so build and
 *                            test report `skipped` there — the
 *                            project's real build and tests are the
 *                            mobile gate's business, below)
 *     → mobile gate         (F10: server/android/mobileProjectGate —
 *                            structure, manifest, Gradle and resource
 *                            consistency, a genuine Kotlin compile of
 *                            the project's JVM-pure sources, execution
 *                            of the generated app's own JVM unit
 *                            tests, and the CI build-proof records
 *                            for both platforms)
 *     → verified delivery   (tests + artifact + gate, where for
 *                            mobile the "tests" evidence is the
 *                            gate's JVM run — the web environment
 *                            cannot execute Kotlin tests, and the
 *                            workflow says so instead of borrowing
 *                            the F7/F9 verdict shape unchanged)
 *
 * The Android/iOS claim split is deliberate and recorded in every
 * gate report: local verification proves the generated project is
 * complete, consistent and (for its JVM-pure core) compilable and
 * test-green; the APK is produced by the Phase 34 GitHub Actions
 * workflow and the iOS .app by the Phase 25 macOS workflow — the
 * gate verifies those build-proof paths exist and still pin their
 * evidence gates, and claims nothing beyond that. No APK is built
 * on this host (the Gradle daemon cannot run here), no IPA exists
 * without a signing team, and neither is fabricated.
 *
 * iOS team note (audit finding, recorded in the F10 docs): the F5
 * registry has no iOS category — CanonicalProjectType has no iOS
 * entry, and an "iOS app" request classifies to
 * `cross_platform_mobile`, whose team profile is the Android mobile
 * profile. The iOS engine (server/ios, Phases 25/35) is a standalone
 * generator + validator + macOS pipeline, so the workflow's iOS
 * path is a gate over generated projects (verifyIosProject), not a
 * swarm team build. The data does not pretend otherwise.
 */
export interface MobileWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface MobileWorkflowDelivery {
  projectId: string;
  environment: 'web';
  /** The contract build outcome, reported as the adapter reported it. */
  build: EnvironmentBuildResult;
  /** The contract test-cycle outcome, reported as the adapter reported it. */
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  gate: AndroidGateReport;
  /** True only when the mobile gate passed and a real artifact was exported. */
  verified: boolean;
}

export class MobileWorkflow {
  /**
   * Step 1 of the workflow: resolve the mobile team for a
   * description from the F5 registry data. Throws
   * CategoryTeamResolutionError on dangling data — a request never
   * silently falls back to a default team.
   */
  static plan(description: string): MobileWorkflowPlan {
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

  /** The Android gate the workflow applies to delivered files. */
  static async verifyAndroidProject(files: MobileProjectFileInput): Promise<AndroidGateReport> {
    return verifyAndroidProject(files);
  }

  /** The iOS gate the workflow applies to a generated iOS project. */
  static async verifyIosProject(
    files: MobileProjectFileInput,
    config: IosProjectConfig
  ): Promise<IosGateReport> {
    return verifyIosProject(files, config);
  }

  /**
   * The delivery verdict, factored out so it can be asserted
   * directly: a mobile delivery is verified only when the mobile
   * gate passed (structure, manifest, Gradle, resources, Kotlin
   * compile, JVM tests, CI build-proof records) and the environment
   * export produced a non-empty artifact. The contract test cycle is
   * reported in the delivery record but is not the verdict's test
   * evidence — the web environment cannot run Kotlin tests; the
   * gate's JVM execution is.
   */
  static verifyDelivery(input: {
    artifact: EnvironmentArtifact;
    gate: AndroidGateReport;
  }): boolean {
    return input.gate.passed === true && input.artifact.sizeBytes > 0;
  }

  /**
   * Steps 3–4 of the workflow: take a project that already exists in
   * the platform store (the swarm build's output tree) through the
   * F6 environment contract — open, build, test, preview, export —
   * then apply the mobile gate to the delivered files read back
   * through the contract, and compute the delivery verdict.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<MobileWorkflowDelivery> {
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

    const gate = await verifyAndroidProject(files);
    const verified = this.verifyDelivery({ artifact: exported.artifact, gate });

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      gate,
      verified
    };
  }
}
