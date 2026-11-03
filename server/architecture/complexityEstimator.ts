import { 
  RequirementsAnalysis, 
  StackSelectionResult, 
  ProjectComplexityAssessment, 
  ProjectComplexityLevel,
  AgentRole
} from '../types.js';

export class ProjectComplexityEstimator {
  /**
   * Assesses project complexity systematically based on requirements, platforms, and stack decisions.
   */
  static assess(
    analysis: RequirementsAnalysis, 
    stackResult: StackSelectionResult
  ): ProjectComplexityAssessment {
    const { 
      applicationCategory, 
      targetPlatforms, 
      requiredFeatures, 
      externalIntegrations, 
      dataStorageRequirements, 
      unresolvedQuestions 
    } = analysis;

    let score = 20; // baseline score

    // Platform breadth
    if (targetPlatforms.length > 2) score += 20;
    else if (targetPlatforms.length > 1) score += 10;

    // Feature quantity
    score += Math.min(requiredFeatures.length * 4, 30);

    // Integrations
    score += Math.min(externalIntegrations.length * 6, 24);

    // Category weight
    if (applicationCategory === '3d_application' || applicationCategory === 'engineering_application') {
      score += 25;
    } else if (applicationCategory === 'windows_application' || applicationCategory === 'cross_platform_desktop' || applicationCategory === 'cross_platform_mobile') {
      score += 20;
    } else if (applicationCategory === 'saas' || applicationCategory === 'ecommerce') {
      score += 15;
    } else if (applicationCategory === 'api_service' || applicationCategory === 'backend_service' || applicationCategory === 'data_application' || applicationCategory === 'web_application' || applicationCategory === 'fullstack') {
      score += 15;
    } else if (applicationCategory === 'landing_page' || applicationCategory === 'portfolio') {
      score -= 10;
    }

    // Enterprise / Distributed systems complexity boost
    if (/\b(enterprise|erp|microservice|cluster|sharding|multi-region|distributed|ha|high availability)\b/i.test(analysis.originalPrompt)) {
      score += 25;
    }

    // Determine level
    let level: ProjectComplexityLevel = 'medium';
    if (score < 30) {
      level = 'small';
    } else if (score < 55) {
      level = 'medium';
    } else if (score < 75) {
      level = 'large';
    } else if (score < 90) {
      level = 'very_large';
    } else {
      level = 'enterprise_scale';
    }

    // Estimate module count
    const estimatedModulesCount = level === 'small' ? 3 
      : level === 'medium' ? 6 
      : level === 'large' ? 10 
      : level === 'very_large' ? 15 
      : 22;

    // Implementation stages
    const approximateImplementationStages = [
      'Stage 1: System Contracts & Architecture Blueprint Initialization',
      'Stage 2: Core Domain Logic & State Management Subsystems',
      'Stage 3: Interface Construction & Native/Web View Adapters',
      'Stage 4: Automated Testing Matrix, Fuzzing & Security Boundary Hardening',
      'Stage 5: Packaging, Containerization & Release Artifact Verification'
    ];

    if (level === 'very_large' || level === 'enterprise_scale') {
      approximateImplementationStages.splice(3, 0, 'Stage 3.5: Multi-Module Subsystem Integration & RPC Gateway');
    }

    // Required specialist roles
    const requiredSpecialistRoles: AgentRole[] = [
      'project_manager',
      'software_architect',
      'qa_testing_specialist',
      'security_specialist'
    ];

    if (applicationCategory.includes('cli') || applicationCategory.includes('api') || applicationCategory.includes('backend') || applicationCategory.includes('automation')) {
      requiredSpecialistRoles.push('backend_developer');
    } else if (applicationCategory === 'landing_page' || applicationCategory === 'portfolio') {
      requiredSpecialistRoles.push('frontend_developer');
    } else {
      requiredSpecialistRoles.push('frontend_developer');
      requiredSpecialistRoles.push('backend_developer');
      requiredSpecialistRoles.push('fullstack_developer');
    }

    if (dataStorageRequirements.length > 0 && !dataStorageRequirements[0].includes('Client-Side')) {
      requiredSpecialistRoles.push('database_specialist');
    }

    if (targetPlatforms.includes('windows') || targetPlatforms.includes('android') || targetPlatforms.includes('cross_platform')) {
      requiredSpecialistRoles.push('integration_specialist');
    }

    requiredSpecialistRoles.push('devops_release_specialist');

    // Integration and testing complexity
    const integrationComplexity = externalIntegrations.length > 3 || targetPlatforms.length > 2 
      ? 'critical' 
      : externalIntegrations.length > 1 
      ? 'high' 
      : externalIntegrations.length > 0 
      ? 'moderate' 
      : 'low';

    const testingComplexity = level === 'enterprise_scale' || level === 'very_large'
      ? 'critical'
      : level === 'large'
      ? 'high'
      : level === 'medium'
      ? 'moderate'
      : 'low';

    // Major technical risks
    const majorTechnicalRisks: string[] = [];
    if (targetPlatforms.includes('windows') && !targetPlatforms.includes('web')) {
      majorTechnicalRisks.push('Native Windows execution requires host OS binary compilation tooling (.NET / C++ / Win32).');
    }
    if (targetPlatforms.includes('android')) {
      majorTechnicalRisks.push('Android SDK and Gradle build chain required for native APK generation.');
    }
    if (externalIntegrations.length > 0) {
      majorTechnicalRisks.push('External third-party API availability, rate limits, and authentication token expiration.');
    }
    if (unresolvedQuestions.length > 0) {
      majorTechnicalRisks.push(`${unresolvedQuestions.length} unresolved specification questions could cause architectural rework if deferred.`);
    }

    const rationale = `Evaluated ${requiredFeatures.length} required features across ${targetPlatforms.join(', ')} platforms with ${externalIntegrations.length} external integrations. Classification calculated as ${level} (score: ${score}/100).`;

    return {
      level,
      score,
      estimatedModulesCount,
      approximateImplementationStages,
      requiredSpecialistRoles: Array.from(new Set(requiredSpecialistRoles)),
      integrationComplexity,
      testingComplexity,
      expectedRuntimeRequirements: stackResult.runtimeRequirements,
      externalDependenciesCount: externalIntegrations.length + (dataStorageRequirements.length > 0 ? 3 : 1),
      majorTechnicalRisks,
      rationale
    };
  }
}
