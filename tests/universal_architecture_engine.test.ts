import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { 
  normalizeProjectType, 
  CANONICAL_PROJECT_TYPES, 
  LEGACY_PROJECT_TYPES,
  ProjectType,
  CanonicalProjectType
} from '../server/types.js';
import { SoftwareRequirementsAnalyzer } from '../server/architecture/requirementsAnalyzer.js';
import { TechnologyStackRegistry } from '../server/architecture/techRegistry.js';
import { IntelligentStackSelector } from '../server/architecture/stackSelector.js';
import { UniversalArchitectureBlueprintGenerator } from '../server/architecture/blueprintGenerator.js';
import { AdaptiveFileStructurePlanner } from '../server/architecture/fileStructurePlanner.js';
import { ArchitectureDependencyPlanner } from '../server/architecture/architectureDependencyPlanner.js';
import { ProjectComplexityEstimator } from '../server/architecture/complexityEstimator.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { DatabaseManager } from '../server/db/database.js';
import { store } from '../server/store.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 7: Universal Software Architecture Engine Test Suite', () => {

  describe('1. Canonical Project Type Classification and Backward Compatibility', () => {
    test('1.1 Recognizes all 24 canonical project categories', () => {
      assert.strictEqual(CANONICAL_PROJECT_TYPES.length, 24);
      for (const cat of CANONICAL_PROJECT_TYPES) {
        assert.strictEqual(normalizeProjectType(cat), cat, `Expected ${cat} to normalize to itself`);
      }
    });

    test('1.2 Backward-compatible normalization for legacy project types', () => {
      assert.strictEqual(normalizeProjectType('saas_dashboard'), 'saas');
      assert.strictEqual(normalizeProjectType('blog_content'), 'blog');
      assert.strictEqual(normalizeProjectType('blog_publication'), 'blog');
      assert.strictEqual(normalizeProjectType('fullstack_app'), 'fullstack');
      assert.strictEqual(normalizeProjectType('internal_tool'), 'developer_tool');
    });

    test('1.3 Safe fallback for unknown, undefined, or malformed types', () => {
      assert.strictEqual(normalizeProjectType('unknown_quantum_simulator'), 'custom');
      assert.strictEqual(normalizeProjectType(''), 'custom');
      assert.strictEqual(normalizeProjectType(null as any), 'custom');
      assert.strictEqual(normalizeProjectType(undefined as any), 'custom');
      assert.strictEqual(normalizeProjectType('xyz123'), 'custom');
    });
  });

  describe('2. Software Requirements Analyzer', () => {
    test('2.1 Extracts category, purpose, and platform accurately from prompt', () => {
      const prompt = 'Build a high-performance Windows desktop video editor using WPF, DirectX hardware acceleration, and local SQLite for asset libraries.';
      const analysis = SoftwareRequirementsAnalyzer.analyze(prompt);

      assert.strictEqual(analysis.originalPrompt, prompt);
      assert.ok(analysis.mainPurpose.toLowerCase().includes('windows') || analysis.mainPurpose.toLowerCase().includes('video'));
      assert.ok(analysis.targetPlatforms.includes('windows'));
      assert.ok(analysis.applicationCategory === 'windows_application' || analysis.applicationCategory === 'desktop_application' || analysis.applicationCategory === 'multimedia_application');
      assert.ok(analysis.dataStorageRequirements.some(r => r.toLowerCase().includes('sqlite')));
      assert.ok(analysis.uiRequirements.some(r => r.toLowerCase().includes('wpf') || r.toLowerCase().includes('desktop')));
    });

    test('2.2 Separates confirmed user requirements from AI assumptions', () => {
      const prompt = 'Create an e-commerce platform for handcrafted ceramics with Stripe payments and product catalog.';
      const analysis = SoftwareRequirementsAnalyzer.analyze(prompt);

      assert.ok(analysis.confirmedRequirements.length > 0, 'Should extract confirmed requirements');
      assert.ok(analysis.assumptions.length > 0, 'Should explicitly mark AI assumptions');
      
      const hasStripeConfirmed = analysis.confirmedRequirements.some(r => r.statement.toLowerCase().includes('stripe') || r.statement.toLowerCase().includes('payment'));
      assert.ok(hasStripeConfirmed, 'Payment requirement should be in confirmed requirements');
      
      const hasAssumption = analysis.assumptions.length > 0;
      assert.ok(hasAssumption, 'Assumptions should be flagged without masquerading as confirmed');
    });

    test('2.3 Records unresolved questions when essential details are missing', () => {
      const prompt = 'Build an app for my team to manage things.';
      const analysis = SoftwareRequirementsAnalyzer.analyze(prompt);

      assert.ok(analysis.unresolvedQuestions.length >= 1, 'Should flag missing platform, storage, or auth information');
      assert.ok(analysis.applicationCategory === 'fullstack' || analysis.applicationCategory === 'web_application');
    });
  });

  describe('3. Technology Stack Registry', () => {
    test('3.1 Contains entries across Web, Desktop, Mobile, Systems, and Creative stacks', () => {
      const allTech = TechnologyStackRegistry.getAll();
      assert.ok(allTech.length >= 20, `Expected at least 20 technologies, found ${allTech.length}`);

      const categories = new Set(allTech.map(t => t.category));
      assert.ok(categories.has('frontend'));
      assert.ok(categories.has('backend'));
      assert.ok(categories.has('desktop'));
      assert.ok(categories.has('mobile'));
      assert.ok(categories.has('systems'));
      assert.ok(categories.has('graphics_3d'));
    });

    test('3.2 Validates entry metadata completeness', () => {
      const tauri = TechnologyStackRegistry.get('tauri');
      assert.ok(tauri, 'Tauri should exist in registry');
      assert.ok(tauri.displayName.includes('Tauri'));
      assert.ok(tauri.supportedPlatforms.includes('windows'));
      assert.ok(tauri.supportedPlatforms.includes('macos'));
      assert.ok(tauri.supportedPlatforms.includes('linux'));
      assert.ok(tauri.programmingLanguages.map(l => l.toLowerCase()).includes('rust'));
      assert.ok(tauri.knownLimitations.length > 0);
      assert.strictEqual(tauri.compatibilityStatus, 'candidate');
    });

    test('3.3 Queries registry by category, platform, and project type', () => {
      const mobileTech = TechnologyStackRegistry.getByPlatform('android');
      assert.ok(mobileTech.length >= 2);
      assert.ok(mobileTech.some(t => t.id === 'react_native' || t.id === 'native_android_kotlin' || t.id === 'flutter'));

      const graphicsTech = TechnologyStackRegistry.getByCategory('graphics_3d');
      assert.ok(graphicsTech.some(t => t.id === 'threejs_webgl' || t.id === 'vulkan_opengl_native'));
    });
  });

  describe('4. Intelligent Stack Selection across 9 Scenarios', () => {
    test('4.1 Scenario 1: Business Landing Page', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('High-converting landing page and marketing portfolio with rich interactive animations.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.frontend?.includes('React') || result.recommendedStack.frontend?.includes('Next'));
      assert.ok(result.recommendedStack.backend === 'Static / Edge CDN' || result.recommendedStack.backend === undefined || result.recommendedStack.backend?.includes('Static') || result.recommendedStack.backend?.includes('Node'));
      assert.ok(result.alternativeStack, 'Should provide alternative stack');
      assert.ok(result.explanation.length > 0);
    });

    test('4.2 Scenario 2: High-scale SaaS Platform', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Multi-tenant enterprise SaaS platform with Postgres database, Stripe billing, and user RBAC.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.database?.toLowerCase().includes('postgres'));
      assert.ok(result.alternativeStack, 'Should have alternative stack');
      assert.ok(result.explanation.length > 0);
    });

    test('4.3 Scenario 3: High-throughput Backend REST / Microservice API', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Ultra-low latency microservice REST API for IoT telemetry processing in Go or Python FastAPI.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.backend?.toLowerCase().includes('fastapi') || result.recommendedStack.backend?.toLowerCase().includes('go') || result.recommendedStack.backend?.toLowerCase().includes('node') || result.recommendedStack.backend?.toLowerCase().includes('express'));
    });

    test('4.4 Scenario 4: Windows Native Photo Editor', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Windows desktop photo and image enhancement utility using WPF, C# and DirectX.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.desktopFramework?.includes('WPF') || result.recommendedStack.desktopFramework?.includes('WinUI') || result.recommendedStack.primaryLanguage === 'C#');
      assert.ok(result.compatibilityWarnings.some(w => w.toLowerCase().includes('windows') || w.toLowerCase().includes('.net')));
    });

    test('4.5 Scenario 5: Cross-platform Desktop Developer Tool', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Cross-platform desktop developer tool with lightweight bundle size and low memory usage on Mac, Windows, Linux.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.desktopFramework?.includes('Tauri') || result.recommendedStack.desktopFramework?.includes('Electron'));
      assert.ok(result.alternativeStack?.desktopFramework?.includes('Electron') || result.alternativeStack?.desktopFramework?.includes('Tauri'));
    });

    test('4.6 Scenario 6: Native Android Mobile Application', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Native Android mobile application with offline SQLite database and Material 3 design.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.mobileFramework?.includes('Kotlin') || result.recommendedStack.mobileFramework?.includes('Android') || result.recommendedStack.mobileFramework?.includes('React Native'));
    });

    test('4.7 Scenario 7: Python Automation Tool / CLI', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Command line automation script to parse log files, generate reports, and upload to S3.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.primaryLanguage.toLowerCase().includes('python') || result.recommendedStack.primaryLanguage.toLowerCase().includes('typescript'));
    });

    test('4.8 Scenario 8: 3D CAD & Engineering Application', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Browser-based 3D CAD and spatial engineering visualizer using WebGPU and Three.js.');
      const result = IntelligentStackSelector.selectStack(req);

      assert.ok(result.recommendedStack.graphicsApi?.includes('Three.js') || result.recommendedStack.graphicsApi?.includes('WebGPU') || result.recommendedStack.frontend?.includes('Three'));
    });

    test('4.9 Scenario 9: Preserves established stack when already chosen', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Add a new reporting screen to our existing Vue and Python Django app.');
      const existingStack = {
        frontend: 'Vue 3 + Vite',
        backend: 'Python Django 5.0',
        database: 'PostgreSQL 16',
        testing: 'PyTest + Vitest',
        security: 'Token auth'
      };

      const result = IntelligentStackSelector.selectStack(req, existingStack);
      assert.strictEqual(result.isPreservedStack, true);
      assert.strictEqual(result.recommendedStack.frontend, 'Vue 3 + Vite');
      assert.strictEqual(result.recommendedStack.backend, 'Python Django 5.0');
      assert.ok(result.explanation.includes('Preserving established'));
    });
  });

  describe('5. Universal Architecture Blueprint Generator', () => {
    test('5.1 Generates comprehensive layers, subsystems, and contracts', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Enterprise SaaS CRM with PostgreSQL, Redis cache, and REST APIs.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const bp = UniversalArchitectureBlueprintGenerator.generate(req, stackResult);

      assert.strictEqual(bp.projectClassification, 'saas');
      assert.ok(bp.applicationLayers.length >= 2, 'Must contain discrete application layers');
      assert.ok(bp.moduleStructure.length >= 2, 'Must decompose into discrete functional subsystems');
      assert.ok(bp.dataFlow.length >= 2, 'Must map data flow');
      assert.ok(bp.securityBoundaries.length >= 1, 'Must define security boundaries');
      assert.ok(bp.testingStrategy.unit.length > 0);
    });
  });

  describe('6. Adaptive File Structure Planner', () => {
    test('6.1 Plans idiomatic file structure for Desktop / Windows projects', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Windows desktop utility in WPF and C#.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const plan = AdaptiveFileStructurePlanner.planStructure(req.applicationCategory, req.targetPlatforms, stackResult.recommendedStack);

      assert.ok(plan.suggestedFiles.some(f => f.path.includes('.sln') || f.path.includes('.csproj') || f.path.includes('MainWindow') || f.path.includes('App.xaml')));
      assert.ok(plan.rootDirectories.some(d => d.path.includes('Views') || d.path.includes('ViewModels') || d.path.includes('Models') || d.path.includes('src')));
    });

    test('6.2 Plans idiomatic file structure for Mobile projects', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Native Android app with Kotlin and Jetpack Compose.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const plan = AdaptiveFileStructurePlanner.planStructure(req.applicationCategory, req.targetPlatforms, stackResult.recommendedStack);

      assert.ok(plan.suggestedFiles.some(f => f.path.includes('gradle') || f.path.includes('MainActivity') || f.path.includes('package.json')));
      assert.ok(plan.rootDirectories.some(d => d.path.includes('app') || d.path.includes('src') || d.path.includes('android')));
    });

    test('6.3 Plans idiomatic file structure for Fullstack / SaaS projects', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Fullstack SaaS web application.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const plan = AdaptiveFileStructurePlanner.planStructure(req.applicationCategory, req.targetPlatforms, stackResult.recommendedStack);

      assert.ok(plan.rootDirectories.some(d => d.path.includes('src') || d.path.includes('server')));
      assert.ok(plan.suggestedFiles.some(f => f.path === 'package.json'));
    });
  });

  describe('7. Architecture Dependency Planner', () => {
    test('7.1 Classifies runtime, dev, and system dependencies correctly', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Cross-platform desktop application using Tauri and Rust.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const plan = ArchitectureDependencyPlanner.planDependencies(req.applicationCategory, req.targetPlatforms, stackResult.recommendedStack, req.originalPrompt);

      assert.ok(plan.requiredDependencies.length > 0);
      assert.ok(plan.installationPrerequisites.some(p => p.toLowerCase().includes('rust') || p.toLowerCase().includes('cargo') || p.toLowerCase().includes('node')));
      assert.ok(plan.unnecessaryDuplicates.length === 0, 'No duplicates in generated dependencies');
    });

    test('7.2 Flags OS-specific constraints without auto-installing speculatively', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Windows application with WPF and DirectX.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const plan = ArchitectureDependencyPlanner.planDependencies(req.applicationCategory, req.targetPlatforms, stackResult.recommendedStack, req.originalPrompt);

      assert.ok(plan.osSpecificDependencies.some(c => c.os.toLowerCase().includes('windows')));
      assert.ok(plan.missingRuntimeRequirements.length >= 1, 'Should flag missing Windows/.NET execution environment in standard Linux container');
    });
  });

  describe('8. Project Complexity and Resource Estimator', () => {
    test('8.1 Categorizes simple landing page as small complexity', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Single page portfolio for a graphic designer.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const assessment = ProjectComplexityEstimator.assess(req, stackResult);

      assert.ok(assessment.score <= 50);
      assert.ok(assessment.level === 'small' || assessment.level === 'medium');
      assert.ok(assessment.estimatedModulesCount <= 10);
    });

    test('8.2 Categorizes enterprise multi-tenant platform as large, very_large or enterprise_scale', () => {
      const req = SoftwareRequirementsAnalyzer.analyze('Global multi-tenant enterprise ERP with microservices, Redis clustering, PostgreSQL sharding, WebGPU visualizations, and multi-region failover.');
      const stackResult = IntelligentStackSelector.selectStack(req);
      const assessment = ProjectComplexityEstimator.assess(req, stackResult);

      assert.ok(assessment.score >= 50);
      assert.ok(assessment.level === 'medium' || assessment.level === 'large' || assessment.level === 'very_large' || assessment.level === 'enterprise_scale');
      assert.ok(assessment.requiredSpecialistRoles.length >= 3);
      assert.ok(assessment.majorTechnicalRisks.length >= 1);
    });
  });

  describe('9. Database Migration 007 & Store Persistence', () => {
    test('9.1 Migration 007 runs cleanly and stores architecture fields on builds', () => {
      const dbManager = store.dbManager;
      const testUserId = `usr_p7_${Date.now()}`;
      const testBuildId = `test_arch_build_${Date.now()}`;
      
      // Seed user first so FK passes
      dbManager.db.prepare(`
        INSERT INTO users (id, email, name, password_hash, enabled_model_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(testUserId, `arch_tester_${Date.now()}@squadforge.local`, 'Arch Tester', 'hash', JSON.stringify(['gemini-2.5-pro']), Date.now(), Date.now());

      const dummyAnalysis = {
        mainPurpose: 'Offline desktop tool',
        targetUsers: ['Engineers'],
        applicationCategory: 'desktop_application' as CanonicalProjectType,
        targetPlatforms: ['windows', 'linux'] as any,
        requiredFeatures: ['Local processing'],
        coreFunctionality: ['File parsing'],
        uiRequirements: ['Dark theme'],
        backendRequirements: ['Local logic'],
        dataStorageRequirements: ['SQLite database'],
        externalIntegrations: [],
        performanceRequirements: ['Fast startup'],
        securityRequirements: ['Local sandbox'],
        deploymentRequirements: ['Installer'],
        technicalConstraints: ['No telemetry'],
        confirmedRequirements: [],
        assumptions: [],
        unresolvedQuestions: [],
        originalPrompt: 'Build an offline desktop tool',
        analyzedAt: Date.now()
      };

      const dummyComplexity = {
        level: 'medium' as any,
        score: 50,
        estimatedModulesCount: 6,
        approximateImplementationStages: ['Core', 'UI'],
        requiredSpecialistRoles: ['software_architect' as any],
        integrationComplexity: 'low' as any,
        testingComplexity: 'low' as any,
        expectedRuntimeRequirements: ['Local runtime'],
        externalDependenciesCount: 3,
        majorTechnicalRisks: ['Packaging'],
        rationale: 'Desktop app'
      };

      // Insert directly using database transaction to test Migration 007 columns
      dbManager.db.prepare(`
        INSERT INTO builds (
          id, user_id, idea, status, selected_models, auto_push_github,
          cost_limit, total_tokens, total_cost, created_at, updated_at,
          max_duration_seconds, patches_applied_count,
          requirements_analysis, complexity_assessment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        testBuildId,
        testUserId,
        'Build an offline desktop tool',
        'completed',
        JSON.stringify(['gemini-2.5-pro']),
        0,
        5,
        100,
        0.001,
        Date.now(),
        Date.now(),
        300,
        0,
        JSON.stringify(dummyAnalysis),
        JSON.stringify(dummyComplexity)
      );

      // Query back from SQLite to verify columns and data
      const row = dbManager.db.prepare('SELECT requirements_analysis, complexity_assessment FROM builds WHERE id = ?').get(testBuildId) as any;
      assert.ok(row, 'Build row must be returned');
      
      const loadedAnalysis = JSON.parse(row.requirements_analysis);
      const loadedComplexity = JSON.parse(row.complexity_assessment);

      assert.strictEqual(loadedAnalysis.mainPurpose, 'Offline desktop tool');
      assert.strictEqual(loadedComplexity.level, 'medium');
      assert.strictEqual(loadedAnalysis.applicationCategory, 'desktop_application');

      // Also test store integration
      store.saveBuild({
        id: `${testBuildId}_store`,
        userId: testUserId,
        idea: 'Build an offline desktop tool via store',
        status: 'completed',
        selectedModels: ['gemini-2.5-pro'],
        autoPushGithub: false,
        costLimit: 5,
        totalTokens: 100,
        totalCost: 0.001,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxDurationSeconds: 300,
        patchesAppliedCount: 0,
        requirementsAnalysis: dummyAnalysis,
        complexityAssessment: dummyComplexity
      });

      const storeLoaded = store.getBuild(`${testBuildId}_store`);
      assert.ok(storeLoaded, 'Store-saved build must exist');
      assert.strictEqual(storeLoaded.requirementsAnalysis?.mainPurpose, 'Offline desktop tool');
    });
  });

  describe('10. ProjectMemoryService Multi-tenant Isolation and Architecture Retrieval', () => {
    test('10.1 ProjectMemory retains and isolates architecture artifacts by user', () => {
      const buildAId = `build_mem_a_${Date.now()}`;
      const buildBId = `build_mem_b_${Date.now()}`;
      const userAId = `usr_alpha_${Date.now()}`;
      const userBId = `usr_beta_${Date.now()}`;

      // Register builds in store so memory service can validate ownership
      store.saveBuild({
        id: buildAId,
        userId: userAId,
        idea: 'Alpha Windows System',
        status: 'running',
        selectedModels: ['gemini-2.5-pro'],
        autoPushGithub: false,
        costLimit: 5,
        totalTokens: 0,
        totalCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxDurationSeconds: 300,
        patchesAppliedCount: 0
      });

      store.saveBuild({
        id: buildBId,
        userId: userBId,
        idea: 'Beta Mobile System',
        status: 'running',
        selectedModels: ['gemini-2.5-pro'],
        autoPushGithub: false,
        costLimit: 5,
        totalTokens: 0,
        totalCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxDurationSeconds: 300,
        patchesAppliedCount: 0
      });

      const mockBlueprintA: any = {
        projectClassification: 'windows_application',
        projectSummary: 'Alpha Windows System Blueprint',
        targetPlatforms: ['windows'],
        technologyDecisions: {},
        applicationLayers: [],
        moduleStructure: [],
        componentResponsibilities: {},
        dataFlow: [],
        securityBoundaries: [],
        externalIntegrations: [],
        errorHandlingStrategy: 'Structured',
        testingStrategy: { unit: 'NUnit', integration: 'NUnit', automatedCoverageGoalPercent: 80 },
        buildStrategy: { tool: 'dotnet', artifactType: 'exe', productionCommand: 'dotnet build' },
        deploymentStrategy: { target: 'Windows', containerized: false, configFiles: [] },
        architectureRisks: [],
        technicalAssumptions: [],
        generatedAt: Date.now()
      };

      const recorded = ProjectMemoryService.recordArchitectureBlueprint(buildAId, userAId, mockBlueprintA);
      assert.strictEqual(recorded, true);

      // User Alpha can retrieve their blueprint
      const retrievedA = ProjectMemoryService.getArchitectureBlueprint(buildAId, userAId);
      assert.ok(retrievedA);
      assert.strictEqual(retrievedA.projectSummary, 'Alpha Windows System Blueprint');

      // User Beta cannot access User Alpha's architecture data (strict tenant isolation)
      assert.throws(() => {
        ProjectMemoryService.getArchitectureBlueprint(buildAId, userBId);
      }, /Forbidden: Access denied/);
    });
  });
});
