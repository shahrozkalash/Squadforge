import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  probeAiAppBehaviour,
  type AiAppContract,
  type AiAppGateReport,
  type AiStubProvider
} from './aiAppGate.js';

/**
 * Factory Phase F12 — the AI Applications workflow.
 *
 * A described AI application — an application that itself calls AI
 * models at runtime — flows through the factory machinery as a
 * single workflow, using only the surfaces the earlier Factory
 * phases established (the F7/F9 pattern):
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the AI
 *                            Application Team and its generation
 *                            profile are data, selected never
 *                            hardcoded here; F12 registered the
 *                            category, profile, and team as data
 *                            because none existed)
 *     → swarm build         (F2–F4 chain, driven by the caller via
 *                            SwarmOrchestrator)
 *     → environment cycle   (F6: the built project is opened through
 *                            the one FactoryEnvironment contract —
 *                            web adapter — and built / tested /
 *                            previewed / exported through contract
 *                            operations only)
 *     → AI gate             (F12: probeAiAppBehaviour — the delivered
 *                            application is started for real and its
 *                            AI behaviour is probed over HTTP: with
 *                            no provider configured its AI endpoint
 *                            must fail loudly with the router's
 *                            named error and never fabricate an
 *                            answer; with the provider transport
 *                            stubbed (the Phase 33 seam) the same
 *                            endpoint must complete a real round
 *                            trip through the platform's real
 *                            gateway/router code, once per
 *                            configured model id)
 *     → verified delivery   (tests passed + a real artifact + the
 *                            AI gate passed; nothing less verifies)
 *
 * The application's runtime dependency is the platform's provider
 * layer itself: the host injects the gateway module
 * (SQUADFORGE_GATEWAY_MODULE) and provider configuration into the
 * application process, exactly as the platform's own subsystems use
 * the gateway in-process. Provider keys stay server-side in the
 * host environment (invariant 7); application code holds none.
 */
export interface AiWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface AiWorkflowDelivery {
  projectId: string;
  environment: 'web';
  /** The contract build outcome, reported as the adapter reported it. */
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  aiGate: AiAppGateReport;
  /** True only when tests passed, an artifact exists, and the AI gate passed. */
  verified: boolean;
}

/** Absolute path of the platform gateway module the host injects. */
export function platformGatewayModulePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../gateway.ts');
}

export class AiWorkflow {
  /**
   * Step 1 of the workflow: resolve the team for an AI-application
   * description from the F5 registry data. Throws
   * CategoryTeamResolutionError on dangling data — a request never
   * silently falls back to a default team.
   */
  static plan(description: string): AiWorkflowPlan {
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
   * directly: an AI delivery is verified only when the environment
   * test cycle passed, the export produced a non-empty artifact,
   * and the AI gate passed (surface works, no-provider run failed
   * loudly with no fabricated answer, every stub round trip
   * completed). An application that fabricates AI output fails here
   * even if every other stage was green.
   */
  static verifyDelivery(input: {
    tests: EnvironmentTestResult;
    artifact: EnvironmentArtifact;
    aiGate: AiAppGateReport;
  }): boolean {
    return (
      input.tests.status === 'passed' &&
      input.tests.failed === 0 &&
      input.artifact.sizeBytes > 0 &&
      input.aiGate.passed === true
    );
  }

  /**
   * Steps 3–4 of the workflow: take a project that already exists in
   * the platform store (the swarm build's output tree) through the
   * F6 environment contract — open, build, test, preview, export —
   * then read the delivered files back through the contract, apply
   * the AI gate to them, and compute the delivery verdict.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
    contract: AiAppContract;
    stubProvider?: AiStubProvider;
    modelIds?: string[];
    gatewayModulePath?: string;
  }): Promise<AiWorkflowDelivery> {
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

    const aiGate = await probeAiAppBehaviour(files, input.contract, {
      gatewayModulePath: input.gatewayModulePath ?? platformGatewayModulePath(),
      stubProvider: input.stubProvider,
      modelIds: input.modelIds
    });
    const verified = this.verifyDelivery({
      tests,
      artifact: exported.artifact,
      aiGate
    });

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      aiGate,
      verified
    };
  }
}
