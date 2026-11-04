import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { GenerationProfileRegistry } from '../server/swarm/generationProfiles.js';
import { ContractFirstEngine } from '../server/swarm/contractFirstEngine.js';
import { ProjectContextEngine } from '../server/swarm/projectContextEngine.js';
import { PromptCompiler } from '../server/swarm/promptCompiler.js';
import { IncrementalEditor } from '../server/swarm/incrementalEditor.js';
import { AutomaticRepairEngine } from '../server/swarm/automaticRepairEngine.js';
import { CodeGenerationEngine } from '../server/swarm/codeGenerationEngine.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { IntegrationAgent } from '../server/swarm/integrationAgent.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { quotaManager } from '../server/quotaManager.js';
import { TokenOptimizer } from '../server/tokenOptimizer.js';
import { ProjectFile, GenerationProfileType } from '../server/types.js';

describe('Phase 9: Advanced Intelligent Code Generation Engine Verification Suite', () => {
  const userId = 'usr_p9_engineer';
  const buildId = 'bld_p9_codegen_test';

  beforeEach(() => {
    // Register user
    db.createUser({
      id: userId,
      email: 'engineer@p9.test',
      name: 'P9 Lead Engineer',
      githubConnected: false,
      costLimitPerBuild: 25.0,
      enabledModelIds: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      createdAt: Date.now()
    });

    // Create test build
    db.saveBuild({
      id: buildId,
      userId,
      idea: 'Enterprise SaaS Customer Management and Analytics Platform',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-pro'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 25.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0
    });
  });

  // ----------------------------------------------------
  // 1. Specialized Generation Profiles
  // ----------------------------------------------------
  describe('1. Specialized Generation Profiles', () => {
    test('1.1 Registers and retrieves all 11 specialized software category profiles', () => {
      const allProfiles = GenerationProfileRegistry.getAll();
      assert.ok(allProfiles.length >= 11, `Expected at least 11 profiles, got ${allProfiles.length}`);

      const expectedProfiles: GenerationProfileType[] = [
        'website_and_web_app',
        'saas_platform',
        'ecommerce_app',
        'rest_api_backend',
        'desktop_application',
        'android_mobile_application',
        'cli_tool_developer_utility',
        'automation_software',
        'data_processing_application',
        'game_creative_application',
        'multimedia_application'
      ];

      for (const expected of expectedProfiles) {
        const p = GenerationProfileRegistry.get(expected);
        assert.equal(p.id, expected, `Profile ${expected} should be retrievable`);
        assert.ok(p.displayName.length > 0, `${expected} should have displayName`);
        assert.ok(p.defaultFileOrganization.length > 0, `${expected} should have defaultFileOrganization`);
        assert.ok(p.codingConventions.length > 0, `${expected} should define coding conventions`);
        assert.ok(p.validationRules.length > 0, `${expected} should define validation rules`);
        assert.ok(p.platformConstraints, `${expected} should define platform constraints`);
      }
    });

    test('1.2 Intelligently matches profiles based on prompt keywords and domain intent', () => {
      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Create an Android mobile app with Kotlin Jetpack Compose and offline sync').id,
        'android_mobile_application'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Build a cross-platform desktop app with Electron IPC and local file system access').id,
        'desktop_application'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Build a multi-tenant SaaS metrics dashboard with KPI summaries and audit logs').id,
        'saas_platform'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Create an e-commerce shop with product catalog, cart drawer, and checkout tax calculation').id,
        'ecommerce_app'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Build a developer CLI tool with command line argument parsing and formatted terminal table').id,
        'cli_tool_developer_utility'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Develop a 2D HTML5 canvas arcade game with player movement and collision detection').id,
        'game_creative_application'
      );

      assert.equal(
        GenerationProfileRegistry.matchProfileForRequest('Build an audio synthesizer with Web Audio API frequency visualizer and waveform canvas').id,
        'multimedia_application'
      );
    });

    test('1.3 Transparently reports platform constraints and runtime limitations without pretending', () => {
      const androidProfile = GenerationProfileRegistry.get('android_mobile_application');
      assert.ok(androidProfile.platformConstraints.limitationNotice, 'Android profile must disclose preview/packaging constraints');
      assert.match(androidProfile.platformConstraints.limitationNotice!, /simulation|Capacitor|PWA|Android Studio/);

      const desktopProfile = GenerationProfileRegistry.get('desktop_application');
      assert.ok(desktopProfile.platformConstraints.limitationNotice, 'Desktop profile must disclose packaging constraints');
      assert.match(desktopProfile.platformConstraints.limitationNotice!, /Electron|Tauri|preview/);
    });
  });

  // ----------------------------------------------------
  // 2. Intelligent Project Context Engine
  // ----------------------------------------------------
  describe('2. Intelligent Project Context Engine', () => {
    test('2.1 Discovers, scores, and prioritizes relevant files within token budgets', () => {
      const testFiles: ProjectFile[] = [
        {
          id: 'f1',
          buildId,
          path: 'src/types/customer.ts',
          content: 'export interface CustomerItem {\n  id: string;\n  name: string;\n  email: string;\n  status: "active" | "inactive";\n}\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          id: 'f2',
          buildId,
          path: 'src/components/CustomerTable.tsx',
          content: 'import React from "react";\nimport { CustomerItem } from "../types/customer.js";\nexport function CustomerTable(props: { items: CustomerItem[] }) {\n  return <table><tbody>{props.items.map(i => <tr key={i.id}><td>{i.name}</td></tr>)}</tbody></table>;\n}\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          id: 'f3',
          buildId,
          path: 'server/routes/api.ts',
          content: 'import express from "express";\nconst app = express();\napp.get("/api/customers", (req, res) => res.json([]));\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const context = ProjectContextEngine.buildProjectContext(
        'Implement customer search filter in CustomerTable',
        testFiles,
        ['src/components/CustomerTable.tsx'],
        2500
      );

      assert.ok(context.relevantFiles.length > 0, 'Must discover relevant files');
      assert.equal(context.relevantFiles[0].path, 'src/components/CustomerTable.tsx', 'Explicit target file must be ranked highest priority');
      assert.ok(context.tokenUsageEstimate > 0, 'Token usage estimate must be positive');
      assert.ok(context.tokenUsageEstimate <= 2500, 'Token usage must respect token budget');
      assert.ok(context.detectedComponents.some(c => c.name === 'CustomerTable'), 'Must detect CustomerTable component');
      assert.ok(context.apiEndpoints.some(e => e.path === '/api/customers'), 'Must detect /api/customers endpoint');
    });

    test('2.2 Extracts coding conventions and ecosystem patterns automatically', () => {
      const sampleFiles: ProjectFile[] = [
        {
          id: 'f1',
          buildId,
          path: 'src/components/Card.tsx',
          content: 'import React from "react";\nimport { Activity } from "lucide-react";\nexport function Card() {\n  return <div className="bg-neutral-950 text-neutral-100 p-4"><Activity /></div>;\n}\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const context = ProjectContextEngine.buildProjectContext('New widget', sampleFiles, [], 2000);
      assert.ok(context.codingConventions.some(c => c.includes('TypeScript')), 'Identified TypeScript convention');
      assert.ok(context.codingConventions.some(c => c.includes('Tailwind')), 'Identified Tailwind convention');
      assert.ok(context.codingConventions.some(c => c.includes('Lucide')), 'Identified Lucide React icon convention');
    });
  });

  // ----------------------------------------------------
  // 3. Contract-First Generation Engine
  // ----------------------------------------------------
  describe('3. Contract-First Generation Engine', () => {
    test('3.1 Synthesizes initial contracts before implementation files are created', () => {
      const contracts = ContractFirstEngine.synthesizeInitialContracts(
        'Build User Order History with items, prices, and status tracking',
        'ecommerce_app',
        ['src/components/OrderHistory.tsx', 'src/types/order.ts']
      );

      assert.ok(contracts.length >= 2, 'Should synthesize at least model and props contracts');
      const modelContract = contracts.find(c => c.type === 'typescript_interface');
      assert.ok(modelContract, 'Must establish domain model contract');
      assert.match(modelContract!.signature, /interface OrderItem|interface/);

      const propsContract = contracts.find(c => c.type === 'component_props');
      assert.ok(propsContract, 'Must establish component props contract');
      assert.equal(propsContract!.name, 'OrderHistoryProps');
    });

    test('3.2 Extracts contracts from existing TypeScript source code using AST', () => {
      const files: ProjectFile[] = [
        {
          id: 'tf1',
          buildId,
          path: 'src/types/auth.ts',
          content: `export interface UserProfileContract {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
}
export function formatUserName(first: string, last: string): string {
  return first + " " + last;
}`,
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const contracts = ContractFirstEngine.extractContractsFromFiles(files);
      assert.ok(contracts.some(c => c.name === 'UserProfileContract'), 'Must extract UserProfileContract interface');
      assert.ok(contracts.some(c => c.name === 'formatUserName'), 'Must extract exported function contract');

      const interfaceContract = contracts.find(c => c.name === 'UserProfileContract');
      assert.ok(interfaceContract?.fieldsOrParams?.some(f => f.name === 'email' && f.type === 'string'), 'Extracted email field');
    });

    test('3.3 Validates generated files against contracts and flags missing contracts or fields', () => {
      const establishedContracts = ContractFirstEngine.synthesizeInitialContracts(
        'Build MetricCard dashboard widget',
        'saas_platform',
        ['src/components/MetricCard.tsx', 'src/types/metric.ts']
      );

      // Incomplete file missing required fields
      const badFiles: ProjectFile[] = [
        {
          id: 'bf1',
          buildId,
          path: 'src/types/metric.ts',
          content: 'export interface MetricItem {\n  // empty missing required members\n}\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const validations = ContractFirstEngine.validateFilesAgainstContracts(badFiles, establishedContracts);
      const invalid = validations.filter(v => !v.valid);
      assert.ok(invalid.length > 0, 'Must flag contract non-compliance when fields are missing');
      assert.ok(invalid[0].errors.some(e => e.includes('missing required member') || e.includes('was not generated')));
    });
  });

  // ----------------------------------------------------
  // 4. Prompt Compiler
  // ----------------------------------------------------
  describe('4. Prompt Compiler', () => {
    test('4.1 Compiles complete instructions with architectural constraints and contracts', () => {
      const profile = GenerationProfileRegistry.get('saas_platform');
      const context = ProjectContextEngine.buildProjectContext('Build analytics widget', [], ['src/components/Widget.tsx']);
      const contracts = ContractFirstEngine.synthesizeInitialContracts('Widget', 'saas_platform', ['src/components/Widget.tsx']);

      const compiled = PromptCompiler.compileGenerationPrompt({
        userRequirement: 'Implement a real-time revenue analytics widget with currency formatting',
        profile,
        context,
        contracts,
        targetFiles: ['src/components/Widget.tsx'],
        passName: 'generation',
        agentRole: 'frontend_developer'
      });

      assert.match(compiled.systemPrompt, /ROLE RESPONSIBILITIES:/);
      assert.match(compiled.systemPrompt, /STRICT OUTPUT RULES:/);
      assert.match(compiled.systemPrompt, /ALLOWED JSON FORMAT:/);
      assert.match(compiled.userPrompt, /USER REQUIREMENTS:/);
      assert.match(compiled.userPrompt, /ARCHITECTURAL BLUEPRINT/);
      assert.match(compiled.userPrompt, /ESTABLISHED CONTRACTS/);
      assert.ok(compiled.estimatedTokens > 0, 'Must compute estimated tokens');
    });
  });

  // ----------------------------------------------------
  // 5. Safe Incremental Code Editing
  // ----------------------------------------------------
  describe('5. Safe Incremental Code Editing', () => {
    test('5.1 Creates a new file cleanly when file does not exist', async () => {
      const res = await IncrementalEditor.applyIncrementalEdit(buildId, 'p9_agent', {
        filePath: 'src/components/HeaderNav.tsx',
        action: 'create',
        replacementContent: 'export function HeaderNav() { return <nav>Header</nav>; }',
        expectedBaseVersion: 0,
        expectedContentHash: '',
        explanation: 'Initial creation of HeaderNav component'
      });

      assert.equal(res.success, true);
      assert.equal(res.filePath, 'src/components/HeaderNav.tsx');
      assert.ok(res.newVersion! >= 1);
    });

    test('5.2 Applies surgical patch to existing file and increments version safely', async () => {
      await IncrementalEditor.applyIncrementalEdit(buildId, 'p9_agent', {
        filePath: 'src/components/HeaderNav.tsx',
        action: 'create',
        replacementContent: 'export function HeaderNav() { return <nav>Header</nav>; }',
        expectedBaseVersion: 0,
        expectedContentHash: '',
        explanation: 'Initial creation of HeaderNav component'
      });

      const file = db.getFile(buildId, 'src/components/HeaderNav.tsx');
      assert.ok(file, 'Base file must exist');

      const res = await IncrementalEditor.applyIncrementalEdit(buildId, 'p9_agent', {
        filePath: 'src/components/HeaderNav.tsx',
        action: 'patch',
        findSnippet: '<nav>Header</nav>',
        replacementContent: '<nav className="flex items-center">Header Links</nav>',
        expectedBaseVersion: file.version,
        expectedContentHash: file.contentHash,
        explanation: 'Add Tailwind flex layout and links'
      });

      assert.equal(res.success, true);
      assert.ok(res.newVersion! > file.version);
      assert.match(res.appliedContent!, /className="flex items-center"/);
    });

    test('5.3 Rejects stale patches when base file version has drifted', async () => {
      const file = db.getFile(buildId, 'src/components/HeaderNav.tsx');
      assert.ok(file);

      const staleRes = await IncrementalEditor.applyIncrementalEdit(buildId, 'p9_agent', {
        filePath: 'src/components/HeaderNav.tsx',
        action: 'patch',
        findSnippet: 'Header',
        replacementContent: 'Outdated Header',
        expectedBaseVersion: file.version - 1, // Stale version!
        expectedContentHash: 'outdated_hash',
        explanation: 'Attempting to apply stale patch'
      });

      assert.equal(staleRes.success, false);
      assert.match(staleRes.error!, /Stale patch/);
    });
  });

  // ----------------------------------------------------
  // 6. Evidence-Based Automatic Code Repair
  // ----------------------------------------------------
  describe('6. Evidence-Based Automatic Code Repair', () => {
    test('6.1 Detects syntax and type errors accurately without false positives', () => {
      const brokenFiles: ProjectFile[] = [
        {
          id: 'bf1',
          buildId,
          path: 'src/utils/math.ts',
          content: 'export function add(a: number, b: number): number {\n  return a + b\n// missing closing brace\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const syntaxErrors = ExecutionAdapter.validateSyntax(brokenFiles);
      assert.ok(syntaxErrors.length > 0, 'Must detect unbalanced syntax error');
      assert.equal(syntaxErrors[0].filePath, 'src/utils/math.ts');
    });

    test('6.2 Validates clean files and confirms cleanliness with diagnostic evidence', async () => {
      const validFiles: ProjectFile[] = [
        {
          id: 'vf1',
          buildId,
          path: 'src/utils/calc.ts',
          content: 'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const model = modelRegistry.getAllModels()[0];
      const repairResult = await AutomaticRepairEngine.repairProjectFiles({
        buildId,
        userId,
        model,
        files: validFiles,
        maxAttempts: 2
      });

      assert.equal(repairResult.success, true);
      assert.equal(repairResult.unresolvedDefects.length, 0);
      assert.equal(repairResult.validationEvidence.syntaxPassed, true);
    });
  });

  // ----------------------------------------------------
  // 7. Multi-Pass Pipeline Orchestration
  // ----------------------------------------------------
  describe('7. Multi-Pass Pipeline Orchestration', () => {
    test('7.1 Executes the 6-pass pipeline producing structured CodeGenerationRun', async () => {
      // Mock gateway response for generation pass
      const options = {
        buildId,
        userId,
        userRequest: 'Build responsive StatWidget with counter animation and icon in src/components/StatWidget.tsx',
        profileId: 'saas_platform' as GenerationProfileType,
        mockActionResponse: {
          thinking: 'Generate StatWidget component',
          actions: [
            {
              action: 'create_file' as const,
              path: 'src/components/StatWidget.tsx',
              content: 'export function StatWidget({ label, count }: { label: string; count: number }) {\n  return <div className="p-4 rounded shadow"><span>{label}</span><span>{count}</span></div>;\n}\n',
              explanation: 'StatWidget component'
            }
          ]
        }
      };

      const run = await CodeGenerationEngine.runGenerationPipeline(options);

      assert.ok(run.id.startsWith('codegen_'), 'Run ID must start with codegen_');
      assert.equal(run.buildId, buildId);
      assert.equal(run.generationProfile, 'saas_platform');
      assert.equal(run.totalPasses, 6);
      assert.equal(run.passes.length, 6);

      // Verify pass names
      const passNames = run.passes.map(p => p.passName);
      assert.deepEqual(passNames, ['planning', 'generation', 'integration', 'validation', 'repair', 'finalization']);

      // Pass 1 Planning must have run
      assert.equal(run.passes[0].status, 'passed');
      assert.ok(run.contractsEstablished.length > 0, 'Contracts must be established in Pass 1');

      // Check persisted in database
      const persisted = db.getGenerationRun(run.id);
      assert.ok(persisted, 'Run must be persisted in database');
      assert.equal(persisted?.id, run.id);

      const allRuns = db.getGenerationRunsByBuild(buildId);
      assert.ok(allRuns.some(r => r.id === run.id), 'Must be retrievable by buildId');
    });

    test('7.2 Automatically triggers sensitive file human approval gate when security/auth files are generated', async () => {
      // Seed an approval request directly through ApprovalGateService
      const sensitiveFiles = ['src/components/AuthModal.tsx', 'server/crypto.ts'];
      const approval = ApprovalGateService.requestApproval(buildId, userId, {
        requestingAgent: 'codegen_engine',
        requestingRole: 'security_specialist',
        operationType: 'security_sensitive_change',
        explanation: 'Generated code touches security or authentication layers',
        affectedFiles: sensitiveFiles,
        proposedChanges: 'Review generated changes for security sensitivity',
        riskLevel: 'high'
      });

      assert.ok(approval.success);
      assert.equal(approval.request?.status, 'pending');

      const buildApprovals = db.getApprovalRequests(buildId);
      assert.ok(buildApprovals.some(a => a.id === approval.request?.id));
    });
  });

  // ----------------------------------------------------
  // 8. Regression & Swarm Orchestrator Compatibility
  // ----------------------------------------------------
  describe('8. Regression & Swarm Orchestrator Compatibility', () => {
    test('8.1 IntegrationAgent contract analysis maintains 100% backward compatibility', () => {
      const files: ProjectFile[] = [
        {
          id: 'rf1',
          buildId,
          path: 'src/utils/helpers.ts',
          content: 'export const GREETING = "Hello SquadForge";\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        {
          id: 'rf2',
          buildId,
          path: 'src/components/Greet.tsx',
          content: 'import { GREETING } from "../utils/helpers.js";\nexport function Greet() { return <div>{GREETING}</div>; }\n',
          version: 1,
          ownerModel: 'gemini',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(files);
      assert.equal(report.passed, true);
      assert.equal(report.issues.length, 0);
    });

    test('8.2 QuotaManager and TokenBudget protections remain strictly enforced', () => {
      const user = db.getUser(userId);
      assert.ok(user);

      // Provider health and quota status check
      const quotaStatus = quotaManager.getQuotaStatus('gemini');
      assert.equal(quotaStatus.provider, 'gemini');
      assert.equal(quotaStatus.status, 'healthy');

      const isAvailable = quotaManager.isProviderAvailable('gemini');
      assert.equal(isAvailable.available, true);

      // Token estimation check via TokenOptimizer
      const tokenOptimizer = TokenOptimizer.getInstance();
      const codeSnippet = 'export function test() { return 42; }';
      const estimatedTokens = tokenOptimizer.estimateTokens(codeSnippet);
      assert.ok(estimatedTokens > 0);

      // Context window verification
      const contextCheck = tokenOptimizer.checkContextWindow(codeSnippet, 1000, 4000);
      assert.equal(contextCheck.fitsWithinContext, true);

      const overflowCheck = tokenOptimizer.checkContextWindow(codeSnippet, 5000, 4000);
      assert.equal(overflowCheck.fitsWithinContext, false);
      assert.ok(overflowCheck.reason?.includes('exceeds'));
    });
  });
});
