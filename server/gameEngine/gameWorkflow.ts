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
  checkGamePlayability,
  type GamePlayabilityReport,
  type PlayabilityFileInput
} from './playabilityChecker.js';

/**
 * Factory Phase F7 — the Games workflow.
 *
 * One described game idea flows through the factory machinery as a
 * single workflow, using only the surfaces the earlier Factory phases
 * established:
 *
 *   description
 *     → team by data        (F5: CategoryTeamRegistry — the Game
 *                            Development Team and the
 *                            game_creative_application profile are
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
 *                            only)
 *     → playability verdict (F7: the delivered files are executed
 *                            headlessly by checkGamePlayability; a
 *                            delivery is verified only when the
 *                            contract test cycle passed, a real
 *                            artifact was exported, AND the game is
 *                            actually playable)
 *
 * This module holds the workflow's decision points as code so the
 * verdict logic is shared by the routes and the test suite alike —
 * the suite drives the same methods, not a test-only copy.
 */
export interface GameWorkflowPlan {
  description: string;
  category: CanonicalProjectType;
  teamName: string;
  profileId: CategoryTeamDefinition['profileId'];
  team: CategoryTeamDefinition;
  resolvedTeam: ResolvedCategoryTeam;
}

export interface GameWorkflowDelivery {
  projectId: string;
  environment: 'web';
  /** The contract build outcome, reported as the adapter reported it. */
  build: EnvironmentBuildResult;
  tests: EnvironmentTestResult;
  previewMode: string;
  artifact: EnvironmentArtifact;
  playability: GamePlayabilityReport;
  /** True only when tests passed, an artifact exists, and the game plays. */
  verified: boolean;
}

export class GameWorkflow {
  /**
   * Step 1 of the workflow: resolve the team for a game description
   * from the F5 registry data. Throws CategoryTeamResolutionError on
   * dangling data — a game request never silently falls back to a
   * default team.
   */
  static plan(description: string): GameWorkflowPlan {
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
   * The delivery verdict, factored out so it can be asserted directly:
   * a game delivery is verified only when the environment test cycle
   * passed, the export produced a non-empty artifact, and the
   * headless playability check calls the game playable. A broken game
   * fails here even if every other stage was green.
   */
  static verifyDelivery(input: {
    tests: EnvironmentTestResult;
    artifact: EnvironmentArtifact;
    playability: GamePlayabilityReport;
  }): boolean {
    return (
      input.tests.status === 'passed' &&
      input.tests.failed === 0 &&
      input.artifact.sizeBytes > 0 &&
      input.playability.playable === true
    );
  }

  /** The playability gate the workflow applies to delivered files. */
  static assessPlayability(files: PlayabilityFileInput): GamePlayabilityReport {
    return checkGamePlayability(files);
  }

  /**
   * Steps 3–4 of the workflow: take a project that already exists in
   * the platform store (the swarm build's output tree) through the F6
   * environment contract — open, build, test, preview, export — then
   * apply the playability gate to the delivered files and compute the
   * delivery verdict.
   *
   * Note on the build step: the web adapter's build is bundle
   * validation, and a static HTML5 game has no bundle entry point, so
   * the adapter honestly reports it as skipped. The workflow surfaces
   * that outcome as-is in the delivery record; the game's real build
   * gates are the swarm chain's sandbox verification (which the build
   * already passed) and this cycle's test + playability runs.
   */
  static async runEnvironmentCycle(input: {
    projectId: string;
    userId: string;
    title: string;
  }): Promise<GameWorkflowDelivery> {
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

    const playability = checkGamePlayability(files);
    const verified = this.verifyDelivery({
      tests,
      artifact: exported.artifact,
      playability
    });

    return {
      projectId: input.projectId,
      environment: 'web',
      build,
      tests,
      previewMode: preview.mode,
      artifact: exported.artifact,
      playability,
      verified
    };
  }
}
