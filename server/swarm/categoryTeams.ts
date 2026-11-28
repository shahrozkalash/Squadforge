import {
  AgentRole,
  CanonicalProjectType,
  CategoryTeamDefinition,
  CategoryTeamMember,
  CategoryTeamVerificationChain,
  ModelConfig,
  ResolvedCategoryTeam,
  normalizeProjectType
} from '../types.js';
import { AGENT_SPECS, modelRegistry } from '../modelRegistry.js';
import { GenerationProfileRegistry } from './generationProfiles.js';
import { SoftwareRequirementsAnalyzer } from '../architecture/requirementsAnalyzer.js';

/**
 * Factory Phase F5 — Category AI teams as data.
 *
 * A category's AI team — which agent roles receive its build tasks, in
 * which stage order, which generation profile it builds with, which
 * roles the planner may assign tasks to, and which roles form its
 * verification chain — is declarative data in this registry, consumed
 * by the swarm orchestrator (planner prompt, completion verifier,
 * verification fix tasks). It is NOT a parallel team system: task
 * graphs still come from the existing planners
 * (ConnectedApplicationPlanner / SwarmOrchestrator seeding), and model
 * bindings are never stored here — every role resolves to its model
 * through the model registry (AGENT_SPECS `assignedModelId`, checked
 * against the registry's `agentRole` binding), so replacing a team's
 * model is a registry data change with no code change.
 *
 * The member lists record the roles the platform actually assembles
 * today: the ConnectedApplicationPlanner tier graph (devops foundation,
 * architect contracts, database, backend, frontend, QA) plus the
 * orchestrator's release task for every category, and the reduced
 * landing-page graph (no backend/database/fullstack tasks) for
 * `landing_page`. Category differentiation in the swarm today is the
 * classification + generation profile; per-category task graphs beyond
 * landing_page do not exist yet, and this data does not pretend
 * otherwise — differentiating a category from here is a data change.
 */
export class CategoryTeamResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryTeamResolutionError';
  }
}

/** The verification chain every category is held to today (category-invariant). */
const SWARM_VERIFICATION_CHAIN: CategoryTeamVerificationChain = {
  sandboxIntegrityCheck: true,
  verifierRole: 'software_architect',
  integrationRole: 'integration_specialist',
  repairRole: 'debugging_specialist'
};

/**
 * Members of the full connected-application team, in the stage order of
 * the seeded task graph (ConnectedApplicationPlanner tiers 0-6 plus the
 * orchestrator's release task; the fullstack fallback graph assigns the
 * same roles).
 */
const CONNECTED_APPLICATION_MEMBERS: CategoryTeamMember[] = [
  { role: 'devops_release_specialist', stage: 'foundation' },
  { role: 'software_architect', stage: 'architecture' },
  { role: 'database_specialist', stage: 'data' },
  { role: 'backend_developer', stage: 'backend' },
  { role: 'security_specialist', stage: 'backend' },
  { role: 'frontend_developer', stage: 'frontend' },
  { role: 'fullstack_developer', stage: 'integration' },
  { role: 'qa_testing_specialist', stage: 'verification' }
];

/** Roles the planner may assign tasks to on a connected-application build. */
const CONNECTED_APPLICATION_ASSIGNABLE: AgentRole[] = [
  'software_architect',
  'backend_developer',
  'frontend_developer',
  'fullstack_developer',
  'database_specialist',
  'qa_testing_specialist',
  'security_specialist',
  'devops_release_specialist',
  'debugging_specialist'
];

/**
 * Members of the landing-page team: the seeded landing graph has no
 * backend, database, or fullstack entry task.
 */
const LANDING_PAGE_MEMBERS: CategoryTeamMember[] = [
  { role: 'software_architect', stage: 'architecture' },
  { role: 'frontend_developer', stage: 'frontend' },
  { role: 'qa_testing_specialist', stage: 'verification' },
  { role: 'security_specialist', stage: 'verification' },
  { role: 'devops_release_specialist', stage: 'release' }
];

const LANDING_PAGE_ASSIGNABLE: AgentRole[] = [
  'software_architect',
  'frontend_developer',
  'qa_testing_specialist',
  'security_specialist',
  'devops_release_specialist',
  'debugging_specialist'
];

export class CategoryTeamRegistry {
  private static teams: Map<CanonicalProjectType, CategoryTeamDefinition> = new Map();

  static {
    this.registerDefaults();
  }

  static register(team: CategoryTeamDefinition): void {
    // Store copies so callers cannot mutate the registry's data in place.
    this.teams.set(team.category, {
      ...team,
      members: team.members.map(m => ({ ...m })),
      assignableRoles: [...team.assignableRoles],
      verification: { ...team.verification }
    });
  }

  static getAll(): CategoryTeamDefinition[] {
    return Array.from(this.teams.values());
  }

  /**
   * Selects the team for a project category. Any raw project type is
   * normalized to a canonical category first, so every build maps to a
   * team; a canonical category with no registered team is a data error
   * and fails loudly.
   */
  static selectForCategory(rawCategory?: string | null): CategoryTeamDefinition {
    const category = normalizeProjectType(rawCategory ?? undefined);
    const team = this.teams.get(category);
    if (!team) {
      throw new CategoryTeamResolutionError(
        `Category team resolution failed: no category team is registered for category "${category}".`
      );
    }
    return team;
  }

  /**
   * Selects the team for a free-text project request, using the same
   * deterministic classification the architecture engine applies
   * (SoftwareRequirementsAnalyzer.detectCategory).
   */
  static selectForRequest(userRequest: string, projectType?: string): CategoryTeamDefinition {
    const category = SoftwareRequirementsAnalyzer.detectCategory((userRequest || '').toLowerCase(), projectType);
    return this.selectForCategory(category);
  }

  /**
   * Resolves one role to its registered model through the registry.
   * AGENT_SPECS `assignedModelId` is the assignment of record for team
   * resolution: reassigning a role to another registered model is a
   * data change and is honoured as-is (the provider-independence
   * principle). What is enforced loudly is existence — an unknown role
   * or an assigned model that is not registered throws a
   * CategoryTeamResolutionError naming both, and team data never
   * silently falls back to a different model.
   *
   * Note the division of labour between the registry's two bindings:
   * `assignedModelId` says which model a role is assigned to (used
   * here, and by every direct model call the orchestrator makes for a
   * role — e.g. the completion verifier); `ModelConfig.agentRole` says
   * which role a model fills when claiming tasks in a worker loop. In
   * the shipped registry the two agree for every role (pinned by the
   * F1 and F5 suites); a deliberate reassignment swaps the assigned
   * model for role-directed calls immediately, and for claim-based
   * work the target model must also be the one registered for the
   * role (or selected for the build) — see FACTORY_PHASE_F5 docs.
   */
  static resolveRoleModel(role: AgentRole, teamCategory?: string): ModelConfig {
    const where = teamCategory ? ` in category team "${teamCategory}"` : '';
    const spec = AGENT_SPECS[role];
    if (!spec) {
      throw new CategoryTeamResolutionError(
        `Category team resolution failed${where}: unknown agent role "${role}" — AGENT_SPECS has no entry for it.`
      );
    }
    const model = modelRegistry.getById(spec.assignedModelId);
    if (!model) {
      throw new CategoryTeamResolutionError(
        `Category team resolution failed${where}: role "${role}" is assigned to unregistered model "${spec.assignedModelId}" in AGENT_SPECS.`
      );
    }
    return model;
  }

  /**
   * Resolves a whole team: the referenced generation profile must be
   * registered, member roles must be unique, and every member,
   * assignable, and verification-chain role must resolve to a
   * registered model.
   */
  static resolve(team: CategoryTeamDefinition): ResolvedCategoryTeam {
    const profile = GenerationProfileRegistry.getAll().find(p => p.id === team.profileId);
    if (!profile) {
      throw new CategoryTeamResolutionError(
        `Category team resolution failed: category team "${team.category}" references unknown generation profile "${team.profileId}" — no such profile is registered.`
      );
    }
    const seen = new Set<AgentRole>();
    const members = team.members.map(member => {
      if (seen.has(member.role)) {
        throw new CategoryTeamResolutionError(
          `Category team resolution failed: category team "${team.category}" lists role "${member.role}" more than once.`
        );
      }
      seen.add(member.role);
      return { ...member, modelId: this.resolveRoleModel(member.role, team.category).id };
    });
    for (const role of team.assignableRoles) {
      this.resolveRoleModel(role, team.category);
    }
    return {
      team,
      members,
      verifierModelId: this.resolveRoleModel(team.verification.verifierRole, team.category).id,
      integrationModelId: this.resolveRoleModel(team.verification.integrationRole, team.category).id,
      repairModelId: this.resolveRoleModel(team.verification.repairRole, team.category).id
    };
  }

  static resolveForCategory(rawCategory?: string | null): ResolvedCategoryTeam {
    return this.resolve(this.selectForCategory(rawCategory));
  }

  /** The model that issues the completion verdict for a category. */
  static resolveVerifierModelId(rawCategory?: string | null): string {
    return this.resolveForCategory(rawCategory).verifierModelId;
  }

  private static registerDefaults(): void {
    const connected = (
      category: CanonicalProjectType,
      displayName: string,
      profileId: CategoryTeamDefinition['profileId']
    ): CategoryTeamDefinition => ({
      category,
      displayName,
      profileId,
      members: CONNECTED_APPLICATION_MEMBERS,
      assignableRoles: CONNECTED_APPLICATION_ASSIGNABLE,
      verification: SWARM_VERIFICATION_CHAIN
    });

    // Web development
    this.register({
      category: 'landing_page',
      displayName: 'Web Development Team — Landing Page',
      profileId: 'website_and_web_app',
      members: LANDING_PAGE_MEMBERS,
      assignableRoles: LANDING_PAGE_ASSIGNABLE,
      verification: SWARM_VERIFICATION_CHAIN
    });
    this.register(connected('portfolio', 'Web Development Team — Portfolio', 'website_and_web_app'));
    this.register(connected('blog', 'Web Development Team — Blog & Publishing', 'website_and_web_app'));
    this.register(connected('web_application', 'Web Development Team', 'website_and_web_app'));
    this.register(connected('fullstack', 'Web Development Team — Full-Stack', 'website_and_web_app'));
    this.register(connected('custom', 'Web Development Team — Custom', 'website_and_web_app'));
    this.register(connected('saas', 'Web Development Team — SaaS Platform', 'saas_platform'));
    this.register(connected('ecommerce', 'Web Development Team — E-Commerce', 'ecommerce_app'));

    // Backend engineering
    this.register(connected('api_service', 'Backend Engineering Team — API Service', 'rest_api_backend'));
    this.register(connected('backend_service', 'Backend Engineering Team — Backend Service', 'rest_api_backend'));

    // Desktop software
    this.register(connected('desktop_application', 'Desktop Software Team', 'desktop_application'));
    this.register(connected('windows_application', 'Desktop Software Team — Windows', 'desktop_application'));
    this.register(connected('cross_platform_desktop', 'Desktop Software Team — Cross-Platform', 'desktop_application'));

    // Mobile development
    this.register(connected('android_application', 'Mobile Development Team — Android', 'android_mobile_application'));
    this.register(connected('cross_platform_mobile', 'Mobile Development Team — Cross-Platform', 'android_mobile_application'));

    // Developer tools, automation, data
    this.register(connected('cli_tool', 'Developer Tools Team — CLI', 'cli_tool_developer_utility'));
    this.register(connected('developer_tool', 'Developer Tools Team', 'cli_tool_developer_utility'));
    this.register(connected('automation_tool', 'Automation Team', 'automation_software'));
    this.register(connected('data_application', 'Data Engineering Team', 'data_processing_application'));
    this.register(connected('engineering_application', 'Engineering Tools Team', 'data_processing_application'));

    // AI applications (Factory Phase F12): the delivered application
    // itself calls models through the provider layer at runtime; the
    // team building it is the standard connected-application team.
    this.register(connected('ai_application', 'AI Application Team', 'ai_application'));

    // Games & creative software
    this.register(connected('game_application', 'Game Development Team', 'game_creative_application'));
    this.register(connected('creative_application', 'Creative Software Team', 'game_creative_application'));
    this.register(connected('3d_application', 'Creative Software Team — 3D', 'game_creative_application'));
    this.register(connected('multimedia_application', 'Creative Software Team — Multimedia', 'multimedia_application'));
  }
}
