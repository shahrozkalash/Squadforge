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
import { verifyCliTool, type CliGateReport, type CliToolFileInput } from './cliToolGate.js';

/**
 * Factory Phase F11 — the CLI / OS-tools workflow.
 *
 * One described command-line utility flows through the factory
 * machinery as a single workflow, using only the surfaces the
 * earlier Factory phases established (the F7/F9/F10 pattern):
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the Developer
 *                            Tools Team — CLI and the
 *                            cli_tool_developer_utility profile are
 *                            selected, never hardcoded here)
 *     → swarm build         (F2–F4 chain, driven by the caller via
 *                            SwarmOrchestrator; the delivered files
 *                            follow the generation profile's file
 *                            organization — bin/cli.ts entry, command
 *                            parser, commands, formatter, contracts)
 *     → environment cycle   (F6: the built project is opened through
 *                            the web environment contract and built /
 *                            tested / previewed / exported through
 *                            contract operations only; the outcomes
 *                            are surfaced exactly as the adapter
 *                            reports them — a bin/cli.ts entry point
 *                            is not a bundle entry the web build
 *                            recognises, so build reports `skipped`
 *                            there, while the project's own test
 *                            suite runs through the platform test
 *                            gate; neither is dressed up)
 *     → CLI gate            (F11: server/ide/cliToolGate — the
 *                            delivered tool is materialized into a
 *                            scratch directory and EXECUTED with the
 *                            platform's tsx runner: help, version,
 *                            exact fixture-log counts, a JSON report
 *                            file effect, the init command, and the
 *                            two clean-failure cases with no stack
 *                            traces)
 *     → verified delivery   (gate passed + a real exported artifact)
 *
 * There is no deterministic CLI generator module in the platform
 * (unlike desktop/Android/iOS): the category is served by the
 * Phase 9 generation profile and the swarm. The workflow says so,
 * and the gate's execution evidence is what carries the claim —
 * a CLI tool is verified by running it, not by existing.
 */
export interface CliWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface CliWorkflowDelivery {
  projectId: string;
  environment: 'web';
  /** The contract build outcome, reported as the adapter reported it. */
  build: EnvironmentBuildResult;
  /** The contract test-cycle outcome, reported as the adapter reported it. */
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  gate: CliGateReport;
  /** True only when the CLI gate passed and a real artifact was exported. */
  verified: boolean;
}

export class CliToolWorkflow {
  /**
   * Step 1 of the workflow: resolve the CLI team for a description
   * from the F5 registry data. Throws CategoryTeamResolutionError
   * on dangling data — a request never silently falls back to a
   * default team.
   */
  static plan(description: string): CliWorkflowPlan {
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

  /** The CLI gate the workflow applies to delivered files. */
  static async verifyCliTool(files: CliToolFileInput): Promise<CliGateReport> {
    return verifyCliTool(files);
  }

  /**
   * The delivery verdict, factored out so it can be asserted
   * directly: a CLI delivery is verified only when the execution
   * gate passed (the tool genuinely ran and behaved as declared,
   * including its clean failures) and the environment export
   * produced a non-empty artifact.
   */
  static verifyDelivery(input: {
    artifact: EnvironmentArtifact;
    gate: CliGateReport;
  }): boolean {
    return input.gate.passed === true && input.artifact.sizeBytes > 0;
  }

  /**
   * Steps 3–4 of the workflow: take a project that already exists
   * in the platform store (the swarm build's output tree) through
   * the F6 web environment contract — open, build, test, preview,
   * export — then apply the CLI execution gate to the delivered
   * files read back through the contract, and compute the verdict.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<CliWorkflowDelivery> {
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

    const gate = await verifyCliTool(files);
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
