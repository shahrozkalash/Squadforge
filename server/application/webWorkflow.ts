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
  EnvironmentDeploymentRequest,
  EnvironmentDeploymentValidation,
  EnvironmentTestResult
} from '../environment/index.js';
import {
  probeWebAppRuntime,
  type WebAppContract,
  type WebAppFileInput,
  type WebRuntimeProbeReport
} from './webRuntimeProbe.js';

/**
 * Factory Phase F9 — the Web / SaaS / API workflow.
 *
 * One described web product flows through the factory machinery as a
 * single workflow, using only the surfaces the earlier Factory phases
 * established (the F7/F8 pattern):
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the SaaS /
 *                            web / backend teams and their generation
 *                            profiles are selected, never hardcoded
 *                            here)
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
 *                            only)
 *     → runtime gate        (F9: the delivered application is actually
 *                            started and its declared routes are
 *                            probed over real HTTP —
 *                            probeWebAppRuntime; a delivery is
 *                            verified only when the contract test
 *                            cycle passed, a real artifact was
 *                            exported, AND the running application
 *                            honours its contract)
 *     → deployment gate     (F6 contract: PreDeploymentValidator
 *                            dry-run, then DeploymentService requests
 *                            under the production approval gate — an
 *                            unapproved request deploys nothing; an
 *                            approved one reaches exactly the state
 *                            the selected adapter reaches in this
 *                            environment, never a claimed live
 *                            external deploy)
 *
 * This module holds the workflow's decision points as code so the
 * verdict logic is shared by the routes and the test suite alike —
 * the suite drives the same methods, not a test-only copy.
 */
export interface WebWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface WebWorkflowDelivery {
  projectId: string;
  environment: 'web';
  /** The contract build outcome, reported as the adapter reported it. */
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  runtime: WebRuntimeProbeReport;
  /** True only when tests passed, an artifact exists, and the running app honours its contract. */
  verified: boolean;
}

export class WebWorkflow {
  /**
   * Step 1 of the workflow: resolve the team for a web/SaaS/API
   * description from the F5 registry data. Throws
   * CategoryTeamResolutionError on dangling data — a request never
   * silently falls back to a default team.
   */
  static plan(description: string): WebWorkflowPlan {
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

  /** The runtime gate the workflow applies to delivered files. */
  static async probeRuntime(
    files: WebAppFileInput,
    contract: WebAppContract
  ): Promise<WebRuntimeProbeReport> {
    return probeWebAppRuntime(files, contract);
  }

  /**
   * The delivery verdict, factored out so it can be asserted
   * directly: a web delivery is verified only when the environment
   * test cycle passed, the export produced a non-empty artifact, and
   * the runtime gate saw the application start and honour every
   * declared route. A broken application fails here even if every
   * other stage was green.
   */
  static verifyDelivery(input: {
    tests: EnvironmentTestResult;
    artifact: EnvironmentArtifact;
    runtime: WebRuntimeProbeReport;
  }): boolean {
    return (
      input.tests.status === 'passed' &&
      input.tests.failed === 0 &&
      input.artifact.sizeBytes > 0 &&
      input.runtime.passed === true
    );
  }

  /**
   * Steps 3–4 of the workflow: take a project that already exists in
   * the platform store (the swarm build's output tree) through the F6
   * environment contract — open, build, test, preview, export — then
   * read the delivered files back through the contract, apply the
   * runtime gate to them, and compute the delivery verdict.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
    contract: WebAppContract;
  }): Promise<WebWorkflowDelivery> {
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

    const runtime = await probeWebAppRuntime(files, input.contract);
    const verified = this.verifyDelivery({
      tests,
      artifact: exported.artifact,
      runtime
    });

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      runtime,
      verified
    };
  }

  /**
   * Deployment gate, step 1: the dry-run validation through the
   * contract (PreDeploymentValidator + adapter credential check). No
   * deployment is created and no adapter deploy() is called.
   */
  static async validateDeployment(input: {
    projectId: string;
    userId: string;
    provider?: string;
  }): Promise<EnvironmentDeploymentValidation> {
    const env = createEnvironment('web', { userId: input.userId });
    return env.validateDeployment(input.projectId, { provider: input.provider });
  }

  /**
   * Deployment gate, step 2: a deployment request through the
   * contract, under the DeploymentService production approval gate.
   * Without `approved`, a production request is held at
   * `pending_approval` and nothing is deployed; with it, the pipeline
   * executes against the selected adapter and the returned status is
   * exactly the state the adapter reached — in this environment the
   * static host's in-platform registry state, not a live external
   * deployment.
   */
  static async requestDeployment(input: {
    projectId: string;
    userId: string;
    provider?: string;
    approved?: boolean;
  }): Promise<EnvironmentDeploymentRequest> {
    const env = createEnvironment('web', { userId: input.userId });
    return env.requestDeployment(input.projectId, {
      provider: input.provider,
      environment: 'production',
      approved: input.approved
    });
  }
}
