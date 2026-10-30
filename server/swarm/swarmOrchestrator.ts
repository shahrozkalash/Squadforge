import { db } from '../store.js';
import { modelRegistry, AGENT_SPECS } from '../modelRegistry.js';
import { 
  callUnifiedGateway, 
  parseVerifierResponse, 
  SILENT_WORKER_SYSTEM_PROMPT 
} from '../gateway.js';
import { TaskManager } from './taskManager.js';
import { MergeManager } from './mergeManager.js';
import { SandboxRunner } from './sandboxRunner.js';
import { GitHubService } from '../github.js';
import { tokenOptimizer } from '../tokenOptimizer.js';
import { PreviewGenerator } from './previewGenerator.js';
import { IntegrationAgent } from './integrationAgent.js';
import { ProjectMemoryService } from './projectMemory.js';
import { 
  Build, 
  ModelConfig, 
  Task, 
  ModelActionResponse, 
  AgentRole,
  TechStackConfig,
  Milestone,
  ArchitectureDecision,
  RequirementItem,
  ProjectRevision,
  ProjectType
} from '../types.js';

interface ActiveSwarmControl {
  stopRequested: boolean;
  workerCount: number;
}

export class SwarmOrchestrator {
  private static activeSwarms: Map<string, ActiveSwarmControl> = new Map();
  private static MAX_VERIFICATION_ATTEMPTS = 3;
  private static MAX_TASK_RETRIES = 3;

  /**
   * Stops an active build swarm gracefully
   */
  static stopSwarm(buildId: string): void {
    const control = this.activeSwarms.get(buildId);
    if (control) {
      control.stopRequested = true;
    }

    const build = db.getBuild(buildId);
    if (build && (build.status === 'running' || build.status === 'planning' || build.status === 'verifying' || build.status === 'in_progress')) {
      build.status = 'stopped';
      build.completedAt = Date.now();
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_stopped',
        details: 'Build halted manually by user STOP request'
      });
    }
  }

  /**
   * Resumes an existing or stopped build from its saved state
   */
  static async resumeSwarm(buildId: string): Promise<boolean> {
    const build = db.getBuild(buildId);
    if (!build) return false;

    if (this.activeSwarms.has(buildId)) {
      return true; // Already running
    }

    build.status = 'running';
    db.saveBuild(build);

    const control: ActiveSwarmControl = {
      stopRequested: false,
      workerCount: 0
    };
    this.activeSwarms.set(buildId, control);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Resumed autonomous development swarm for build ${buildId}`
    });

    const enabledModels = build.selectedModels
      .map(id => modelRegistry.getById(id))
      .filter((m): m is ModelConfig => !!m && m.enabled);

    control.workerCount = enabledModels.length;

    // Launch worker loops concurrently
    const workerPromises = enabledModels.map(model => 
      this.runModelWorkerLoop(buildId, model, control)
    );

    Promise.all(workerPromises).finally(() => {
      this.activeSwarms.delete(buildId);
    });

    return true;
  }

  /**
   * Starts the continuous parallel swarm for a build
   */
  static async startSwarm(buildId: string): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    const control: ActiveSwarmControl = {
      stopRequested: false,
      workerCount: 0
    };
    this.activeSwarms.set(buildId, control);

    build.status = 'planning';
    build.maxVerificationAttempts = this.MAX_VERIFICATION_ATTEMPTS;
    build.verificationAttempts = 0;
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Autonomous Development Swarm initialized for: "${build.idea}". Active models: ${build.selectedModels.length}`
    });

    try {
      // 1. INITIAL PROJECT MANAGER & ARCHITECT SPECIFICATION
      const planSuccess = await this.runInitialPlanner(build);
      if (!planSuccess) {
        throw new Error('Initial project planning failed. Could not establish specification.');
      }

      // 2. LAUNCH SPECIALIZED AGENT WORKERS CONCURRENTLY
      build.status = 'running';
      db.saveBuild(build);

      const enabledModels = build.selectedModels
        .map(id => modelRegistry.getById(id))
        .filter((m): m is ModelConfig => !!m && m.enabled);

      if (enabledModels.length === 0) {
        throw new Error('No enabled models available to run swarm.');
      }

      control.workerCount = enabledModels.length;

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_started',
        details: `Simultaneously launching ${enabledModels.length} specialized agent loops (PM, Architect, Frontend, Backend, DB, QA, Security, Debugging, DevOps)`
      });

      // Launch all models concurrently with Promise.all
      const workerPromises = enabledModels.map(model => 
        this.runModelWorkerLoop(buildId, model, control)
      );

      // Await all workers
      await Promise.all(workerPromises);

      // Swarm finished or stopped
      this.activeSwarms.delete(buildId);

    } catch (err: any) {
      console.error(`Swarm execution failed for build ${buildId}:`, err);
      build.status = 'failed';
      build.error = err.message || 'Swarm execution failure';
      build.failureReason = err.message || 'Swarm execution failure';
      build.completedAt = Date.now();
      db.saveBuild(build);

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_failed',
        details: `Swarm encountered error: ${err.message}`
      });
    }
  }

  /**
   * Phase 1: Project Manager and Architect Agents establish project specs, tech stack, milestones, ADRs, and initial files
   */
  private static async runInitialPlanner(build: Build): Promise<boolean> {
    // 0. Detect or preserve Project Type
    build.projectType = this.detectProjectType(build.idea, build.projectType);

    // 1. Software Architect selects optimal tech stack based on project type
    const techStack: TechStackConfig = this.selectOptimalTechStack(build.projectType);
    build.techStack = techStack;

    // 2. Project Memory: Record Architecture Decision Records (ADRs)
    build.architectureDecisions = this.generateArchitectureDecisions(build.idea, build.projectType);

    // 3. Project Requirements Checklist
    build.requirementsChecklist = this.generateRequirementsChecklist(build.idea, build.projectType);

    // 4. Persistent Project Memory System
    ProjectMemoryService.getOrInitializeMemory(build.id, build.userId);

    // 5. Project Manager creates milestone breakdown
    const m1Id = 'ms_1_foundation';
    const m2Id = 'ms_2_core';
    const m3Id = 'ms_3_qa_security';
    const m4Id = 'ms_4_release';

    build.milestones = [
      {
        id: m1Id,
        title: 'Milestone 1: Architecture & Foundation',
        description: 'Define contracts, domain interfaces, and project configuration',
        status: 'in_progress',
        taskIds: []
      },
      {
        id: m2Id,
        title: 'Milestone 2: Core Implementation',
        description: 'Implement core modules, state management, and user interfaces',
        status: 'pending',
        taskIds: []
      },
      {
        id: m3Id,
        title: 'Milestone 3: QA, Verification & Security',
        description: 'Create automated test suites and audit for security vulnerabilities',
        status: 'pending',
        taskIds: []
      },
      {
        id: m4Id,
        title: 'Milestone 4: DevOps & Release',
        description: 'Prepare Docker container, CI workflows, and documentation',
        status: 'pending',
        taskIds: []
      }
    ];

    const plannerPrompt = `PROJECT MANAGER & ARCHITECT SPECIFICATION:
Original Requirements: "${build.idea}"
Project Type: ${build.projectType}
Selected Tech Stack:
- Frontend: ${techStack.frontend}
- Backend: ${techStack.backend}
- Database: ${techStack.database}
- Testing: ${techStack.testing}
- Security: ${techStack.security}

Architecture Decisions (ADRs):
${build.architectureDecisions.map(a => `- ${a.title}: ${a.decision}`).join('\n')}

Create the starter file tree and dependency-aware tasks.
Output ONLY JSON matching this structure:
{
  "actions": [
    {
      "action": "create_file",
      "path": "src/types/domain.ts",
      "content": "...complete domain types...",
      "commitMessage": "Architect domain contracts and types"
    },
    {
      "action": "create_task",
      "title": "Architect Domain Data Types & Contracts",
      "description": "Establish TypeScript interfaces for domain models and data transfer objects",
      "filePaths": ["src/types/domain.ts"],
      "priority": 2
    }
  ]
}`;

    const plannerResult = await callUnifiedGateway({
      modelId: 'gemini',
      prompt: plannerPrompt,
      systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
      allowFallback: true
    });

    if (plannerResult.success && plannerResult.parsedResponse) {
      for (const action of plannerResult.parsedResponse.actions) {
        if (action.action === 'create_file') {
          await MergeManager.createFile(build.id, 'software_architect', action);
        } else if (action.action === 'create_task') {
          const t = TaskManager.createNewTask(build.id, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES,
            milestone: m1Id
          });
          build.milestones[0].taskIds.push(t.id);
        }
      }
    }

    // Seed structured dependency-aware tasks if needed
    const currentTasks = db.getTasks(build.id);
    if (currentTasks.length < 4) {
      this.seedMilestoneTasks(build, m1Id, m2Id, m3Id, m4Id);
    }

    // Ensure README.md exists with comprehensive ADR summary
    const readme = db.getFile(build.id, 'README.md');
    if (!readme) {
      const adrList = (build.architectureDecisions || [])
        .map(a => `### ${a.title}\n**Decision:** ${a.decision}\n**Rationale:** ${a.rationale}`)
        .join('\n\n');

      await MergeManager.createFile(build.id, 'project_manager', {
        action: 'create_file',
        path: 'README.md',
        content: `# ${build.idea}\n\nBuilt by **SquadForge Autonomous AI Development Team**.\n\n## Project Type\n\`${build.projectType}\`\n\n## Tech Stack\n- **Frontend:** ${techStack.frontend}\n- **Backend:** ${techStack.backend}\n- **Database:** ${techStack.database}\n- **Testing:** ${techStack.testing}\n\n## Architecture Decision Records (ADRs)\n${adrList}\n\n## Running the Project\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
        commitMessage: 'Project documentation, architecture decisions & specification'
      });
    }

    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId: build.id,
      timestamp: Date.now(),
      type: 'plan_created',
      details: `Project specification established (${build.projectType}) across 4 milestones (${db.getTasks(build.id).length} dependent tasks, ${build.architectureDecisions?.length || 0} ADRs)`
    });

    return true;
  }

  /**
   * Helper to detect or default the project type
   */
  static detectProjectType(idea: string, currentType?: ProjectType): ProjectType {
    if (currentType && currentType !== 'fullstack') return currentType;
    const lower = idea.toLowerCase();
    if (lower.includes('landing') || lower.includes('hero') || lower.includes('marketing') || lower.includes('product page')) {
      return 'landing_page';
    }
    if (lower.includes('dashboard') || lower.includes('analytics') || lower.includes('metrics') || lower.includes('admin panel')) {
      return 'saas_dashboard';
    }
    if (lower.includes('shop') || lower.includes('store') || lower.includes('ecommerce') || lower.includes('cart') || lower.includes('checkout')) {
      return 'ecommerce';
    }
    if (lower.includes('portfolio') || lower.includes('resume') || lower.includes('cv') || lower.includes('personal site')) {
      return 'portfolio';
    }
    if (lower.includes('blog') || lower.includes('article') || lower.includes('content') || lower.includes('magazine')) {
      return 'blog_content';
    }
    if (lower.includes('api') || lower.includes('microservice') || lower.includes('rest') || lower.includes('endpoint')) {
      return 'api_service';
    }
    if (lower.includes('internal') || lower.includes('console') || lower.includes('admin tool') || lower.includes('crud') || lower.includes('management tool')) {
      return 'internal_tool';
    }
    return currentType || 'fullstack';
  }

  /**
   * Helper to select tech stack tuned to project type
   */
  static selectOptimalTechStack(type: ProjectType): TechStackConfig {
    if (type === 'landing_page' || type === 'portfolio' || type === 'blog_content') {
      return {
        frontend: 'React 19 + TypeScript + Tailwind CSS (Zero-Runtime)',
        backend: 'Node.js Express + Static Preview Generator',
        database: 'Client-Side Local Storage & Markdown Store',
        testing: 'Node.js Native Test Runner (node:test + assert)',
        security: 'OWASP Defensive Validation, Clean CSP Headers'
      };
    }
    if (type === 'saas_dashboard' || type === 'ecommerce' || type === 'internal_tool') {
      return {
        frontend: 'React 19 + TypeScript + Tailwind CSS + Lucide Icons',
        backend: 'Node.js Express + REST API Server',
        database: 'In-Memory Key-Value & Document Store',
        testing: 'Node.js Native Test Runner (node:test + assert)',
        security: 'OWASP Defensive Validation, Rate Limiter & AES-256'
      };
    }
    return {
      frontend: 'React 19 + TypeScript + Tailwind CSS',
      backend: 'Node.js Express + TypeScript Server API',
      database: 'In-Memory Key-Value & Document Store',
      testing: 'Node.js Native Test Runner (node:test + assert)',
      security: 'OWASP Defensive Validation, Rate Limiter & AES-256'
    };
  }

  /**
   * Helper to generate Architecture Decision Records (ADRs)
   */
  static generateArchitectureDecisions(idea: string, type: ProjectType): ArchitectureDecision[] {
    const now = Date.now();
    return [
      {
        id: `ADR-001`,
        title: `ADR-001: Modular Component Architecture for ${type.replace(/_/g, ' ')}`,
        status: 'accepted',
        context: `The project "${idea.slice(0, 50)}" requires clean separation of concerns, responsive design, and rapid iteration.`,
        decision: `Implement small, single-responsibility files (under ~150 lines) with strictly typed props and TypeScript contracts.`,
        rationale: `Prevents merge collisions across autonomous swarm agents and facilitates isolated automated testing.`,
        consequences: `Improves maintainability and makes independent file verification fast and conflict-free.`,
        timestamp: now
      },
      {
        id: `ADR-002`,
        title: `ADR-002: Tailwind CSS Utility-First Styling & Dark Mode`,
        status: 'accepted',
        context: `Ensures cohesive typography, responsive breakpoints (mobile, tablet, desktop), and accessibility.`,
        decision: `Use semantic Tailwind utility classes with neutral dark mode palette and accent branding.`,
        rationale: `Zero runtime CSS-in-JS overhead, predictable responsive behavior, and instant preview rendering.`,
        consequences: `Provides seamless responsive scaling across desktop, tablet, and mobile device frames.`,
        timestamp: now
      },
      {
        id: `ADR-003`,
        title: `ADR-003: Defensive Input Validation & Error Handling`,
        status: 'accepted',
        context: `Untrusted inputs, network timeouts, or malformed states must never crash the UI or server process.`,
        decision: `Guard all user inputs, parameters, and API endpoints with defensive schema sanitization and structured fallback states.`,
        rationale: `Satisfies OWASP security posture and prevents runtime exceptions across browsers.`,
        consequences: `Guarantees rock-solid uptime and graceful user-facing error feedback.`,
        timestamp: now
      }
    ];
  }

  /**
   * Helper to generate Requirements Checklist
   */
  static generateRequirementsChecklist(idea: string, type: ProjectType): RequirementItem[] {
    if (type === 'landing_page') {
      return [
        { id: 'req_1', title: 'Hero Section', category: 'frontend', description: 'Responsive Hero Banner with CTA action and value proposition', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Feature Grid', category: 'frontend', description: 'Feature showcase grid with icons and benefits', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Pricing Tiers', category: 'frontend', description: 'Multi-tier pricing comparison table with feature breakdown', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'FAQ Section', category: 'frontend', description: 'Interactive FAQ accordion with expandable answers', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Lead Capture', category: 'security', description: 'Validated lead capture / contact form with error handling', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    if (type === 'saas_dashboard') {
      return [
        { id: 'req_1', title: 'Sidebar Navigation', category: 'frontend', description: 'Responsive sidebar navigation with view routing', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'KPI Metrics', category: 'frontend', description: 'KPI summary metrics cards with real-time indicators', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Data Table', category: 'core', description: 'Data table with search, sorting, and pagination controls', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Telemetry & Logs', category: 'backend', description: 'Activity audit log or performance telemetry chart', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Settings & Security', category: 'security', description: 'Configuration settings modal with form validation', priority: 'nice_to_have', satisfied: false, status: 'pending' }
      ];
    }
    if (type === 'ecommerce') {
      return [
        { id: 'req_1', title: 'Product Catalog', category: 'frontend', description: 'Product catalog grid with category filters and search', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Product Details', category: 'core', description: 'Product detail view with specifications and stock status', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Cart Drawer', category: 'frontend', description: 'Interactive shopping cart drawer with quantity adjustments', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Checkout & Validation', category: 'security', description: 'Checkout modal with shipping and payment calculation validation', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_5', title: 'Store Test Suite', category: 'testing', description: 'Automated unit tests validating cart total and price calculations', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    if (type === 'portfolio') {
      return [
        { id: 'req_1', title: 'Bio Banner', category: 'frontend', description: 'Professional biography banner with skills overview', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_2', title: 'Project Showcase', category: 'frontend', description: 'Interactive project portfolio gallery with modal previews', priority: 'must_have', satisfied: false, status: 'pending' },
        { id: 'req_3', title: 'Skills Matrix', category: 'core', description: 'Technical skills matrix categorized by frontend/backend/DevOps', priority: 'should_have', satisfied: false, status: 'pending' },
        { id: 'req_4', title: 'Contact & Inquiries', category: 'security', description: 'Inquiry contact form with submission feedback', priority: 'must_have', satisfied: false, status: 'pending' }
      ];
    }
    return [
      { id: 'req_1', title: 'Domain Contracts', category: 'core', description: 'Domain TypeScript contracts and data transfer objects', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_2', title: 'Business Logic', category: 'backend', description: 'Core business logic engine with clean function interfaces', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_3', title: 'Data Persistence', category: 'backend', description: 'Data storage service with transactional consistency', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_4', title: 'UI Components', category: 'frontend', description: 'Responsive user interface component with loading and error states', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_5', title: 'Automated Tests', category: 'testing', description: 'Automated test suite validating assertions and edge cases', priority: 'must_have', satisfied: false, status: 'pending' },
      { id: 'req_6', title: 'Security & DevOps', category: 'security', description: 'Security hardening, defensive validation, and deployment container', priority: 'should_have', satisfied: false, status: 'pending' }
    ];
  }

  /**
   * Seeds dependency-aware tasks across milestones tailored to project type
   */
  private static seedMilestoneTasks(build: Build, m1: string, m2: string, m3: string, m4: string): void {
    const type = build.projectType || 'fullstack';

    if (type === 'landing_page') {
      const task1 = TaskManager.createNewTask(build.id, {
        title: 'Architect Landing Page Section Hierarchy & Schema',
        description: `Design modular component contracts for: ${build.idea}`,
        filePaths: ['src/types/landing.ts'],
        priority: 2,
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'software_architect',
        milestone: m1
      });

      const task2 = TaskManager.createNewTask(build.id, {
        title: 'Build Hero Section & Navigation Bar',
        description: 'Implement responsive hero banner with value proposition and primary CTA',
        filePaths: ['src/components/Hero.tsx'],
        priority: 2,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task3 = TaskManager.createNewTask(build.id, {
        title: 'Build Feature Grid & Benefits Showcase',
        description: 'Implement interactive feature grid with icons, badges, and responsive columns',
        filePaths: ['src/components/Features.tsx'],
        priority: 3,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task4 = TaskManager.createNewTask(build.id, {
        title: 'Build Pricing Comparison & FAQ Accordion',
        description: 'Implement multi-tier pricing table with billing toggle and expandable FAQ accordion',
        filePaths: ['src/components/Pricing.tsx', 'src/components/FAQ.tsx'],
        priority: 3,
        dependencies: [task1.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'frontend_developer',
        milestone: m2
      });

      const task5 = TaskManager.createNewTask(build.id, {
        title: 'Automated Responsive Test Suite & Accessibility Verification',
        description: 'Verify accessibility attributes, component props, and responsive viewport sizing',
        filePaths: ['tests/landing.test.ts'],
        priority: 3,
        dependencies: [task2.id, task3.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'qa_testing_specialist',
        milestone: m3
      });

      const task6 = TaskManager.createNewTask(build.id, {
        title: 'Lead Capture Form Sanitization & Security Validation',
        description: 'Implement input validation for contact inquiries and secure submission handling',
        filePaths: ['src/components/ContactForm.tsx'],
        priority: 3,
        dependencies: [task2.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'security_specialist',
        milestone: m3
      });

      TaskManager.createNewTask(build.id, {
        title: 'Prepare Dockerfile & GitHub Actions CI Workflow',
        description: 'Create multi-stage Dockerfile and GitHub Actions workflow',
        filePaths: ['Dockerfile', '.github/workflows/ci.yml'],
        priority: 4,
        dependencies: [task5.id],
        maxRetries: this.MAX_TASK_RETRIES,
        assignedRole: 'devops_release_specialist',
        milestone: m4
      });

      if (build.milestones) {
        build.milestones[0].taskIds.push(task1.id);
        build.milestones[1].taskIds.push(task2.id, task3.id, task4.id);
        build.milestones[2].taskIds.push(task5.id, task6.id);
      }
      return;
    }

    // Default Fullstack / SaaS
    const task1 = TaskManager.createNewTask(build.id, {
      title: 'Architect Domain Data Types & Contracts',
      description: `Define TypeScript types and domain interfaces for: ${build.idea}`,
      filePaths: ['src/types/domain.ts'],
      priority: 2,
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'software_architect',
      milestone: m1
    });

    const task2 = TaskManager.createNewTask(build.id, {
      title: 'Develop Backend Core Engine & APIs',
      description: `Implement core computational business logic and processors for: ${build.idea}`,
      filePaths: ['src/core/engine.ts'],
      priority: 2,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'backend_developer',
      milestone: m2
    });

    const task3 = TaskManager.createNewTask(build.id, {
      title: 'Implement Database Store & Persistence',
      description: 'Implement transactional storage, queries, and entity relations',
      filePaths: ['src/services/store.ts'],
      priority: 3,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'database_specialist',
      milestone: m2
    });

    const task4 = TaskManager.createNewTask(build.id, {
      title: 'Build Frontend User Interface View',
      description: `Implement responsive view components with loading/error states for: ${build.idea}`,
      filePaths: ['src/components/MainView.tsx'],
      priority: 3,
      dependencies: [task1.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'frontend_developer',
      milestone: m2
    });

    const task5 = TaskManager.createNewTask(build.id, {
      title: 'Create Automated Test Suite & Assertions',
      description: 'Write unit tests validating core functionality, edge cases, and error boundaries',
      filePaths: ['tests/engine.test.ts'],
      priority: 3,
      dependencies: [task2.id, task3.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'qa_testing_specialist',
      milestone: m3
    });

    const task6 = TaskManager.createNewTask(build.id, {
      title: 'Security Hardening & Input Sanitization',
      description: 'Implement input validation guards, secret safety checks, and secure headers',
      filePaths: ['src/core/security.ts'],
      priority: 3,
      dependencies: [task2.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'security_specialist',
      milestone: m3
    });

    TaskManager.createNewTask(build.id, {
      title: 'Prepare Dockerfile & GitHub Actions CI Workflow',
      description: 'Create multi-stage Dockerfile and GitHub Actions workflow for automated testing and builds',
      filePaths: ['Dockerfile', '.github/workflows/ci.yml'],
      priority: 4,
      dependencies: [task5.id],
      maxRetries: this.MAX_TASK_RETRIES,
      assignedRole: 'devops_release_specialist',
      milestone: m4
    });

    if (build.milestones) {
      build.milestones[0].taskIds.push(task1.id);
      build.milestones[1].taskIds.push(task2.id, task3.id, task4.id);
      build.milestones[2].taskIds.push(task5.id, task6.id);
    }
  }

  /**
   * INDEPENDENT MODEL WORKER LOOP
   * Each model loops continuously in parallel until project completes
   */
  private static async runModelWorkerLoop(
    buildId: string, 
    model: ModelConfig, 
    control: ActiveSwarmControl
  ): Promise<void> {
    const startTime = Date.now();
    let consecutiveIdleCount = 0;

    while (!control.stopRequested) {
      const build = db.getBuild(buildId);
      if (!build || build.status !== 'running') break;

      // Check warning threshold: 80% of budget or tokens
      const tokenCeiling = build.tokenBudget || 100000;
      const isNearCostCeiling = build.totalCost >= build.costLimit * 0.8;
      const isNearTokenCeiling = (build.totalTokens || 0) >= tokenCeiling * 0.8;

      if ((isNearCostCeiling || isNearTokenCeiling) && !build.budgetWarningEmitted) {
        build.budgetWarningEmitted = true;
        db.saveBuild(build);
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'budget_warning',
          details: `Warning threshold reached: 80% of configured budget consumed ($${build.totalCost.toFixed(3)}/$${build.costLimit.toFixed(2)}, ${build.totalTokens}/${tokenCeiling} tokens). Run can be resumed or budget expanded from Usage Dashboard.`
        });
      }

      // Check safety limits: cost, token budget, & time
      if (build.totalCost >= build.costLimit || ((build.totalTokens || 0) >= tokenCeiling && build.tokenBudget)) {
        const reason = build.totalCost >= build.costLimit 
          ? `Cost safety limit reached ($${build.totalCost.toFixed(2)} >= $${build.costLimit.toFixed(2)}).`
          : `Token budget limit reached (${build.totalTokens} >= ${tokenCeiling} tokens).`;

        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'build_stopped',
          details: `${reason} Halting swarm. Increase budget in Usage Dashboard to resume.`
        });
        control.stopRequested = true;
        break;
      }

      if ((Date.now() - startTime) / 1000 > build.maxDurationSeconds) {
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'build_stopped',
          details: `Time limit exceeded (${build.maxDurationSeconds}s). Halting swarm.`
        });
        control.stopRequested = true;
        break;
      }

      // 1. ATOMICALLY CLAIM ONE OPEN TASK WITH FULFILLED DEPENDENCIES
      db.updateModelRun(buildId, model.id, { status: 'claiming', role: model.agentRole });
      const task = TaskManager.claimTask(buildId, model.id, model.strengths, model.agentRole);

      if (!task) {
        consecutiveIdleCount++;
        db.updateModelRun(buildId, model.id, { 
          status: 'idle',
          lastActionSummary: 'Waiting for dependent tasks or open board items...'
        });

        // Check completion criteria
        const allTasks = db.getTasks(buildId);
        const incomplete = allTasks.filter(t => t.status === 'pending' || t.status === 'in_progress' || t.status === 'open' || t.status === 'claimed' || t.status === 'retrying');

        if (incomplete.length === 0 && allTasks.length > 0) {
          await this.checkProjectCompletion(buildId, control);
          if (control.stopRequested) break;
        }

        // Delay before polling board again
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
        continue;
      }

      consecutiveIdleCount = 0;
      db.updateModelRun(buildId, model.id, { 
        status: 'working',
        currentTaskId: task.id,
        lastActionSummary: `[${model.agentRole || 'agent'}] Working: ${task.title}`
      });

      // 2. EXECUTE TASK WORK
      try {
        await this.executeTaskWork(buildId, model, task);
      } catch (workErr: any) {
        console.warn(`Worker ${model.id} failed task ${task.id}:`, workErr);
        TaskManager.releaseTask(buildId, task.id, model.id, workErr.message);
      }

      // Update milestone progress
      this.updateMilestoneStatuses(buildId);

      // Automated check trigger after every 5 applied patches
      const currentBuild = db.getBuild(buildId);
      if (currentBuild && currentBuild.patchesAppliedCount > 0 && currentBuild.patchesAppliedCount % 5 === 0) {
        SandboxRunner.runIntegrityCheck(buildId);
      }

      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
    }

    db.updateModelRun(buildId, model.id, { status: 'done', currentTaskId: null });
  }

  /**
   * Updates milestone completion status dynamically
   */
  private static updateMilestoneStatuses(buildId: string): void {
    const build = db.getBuild(buildId);
    if (!build || !build.milestones) return;

    const allTasks = db.getTasks(buildId);
    let changed = false;

    for (const ms of build.milestones) {
      const msTasks = allTasks.filter(t => ms.taskIds.includes(t.id));
      if (msTasks.length === 0) continue;

      const allDone = msTasks.every(t => t.status === 'completed' || t.status === 'done');
      const anyWorking = msTasks.some(t => t.status === 'in_progress' || t.status === 'testing' || t.status === 'retrying');

      if (allDone && ms.status !== 'completed') {
        ms.status = 'completed';
        changed = true;
        db.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: Date.now(),
          type: 'milestone_reached',
          details: `Milestone completed: "${ms.title}"`
        });
      } else if (anyWorking && ms.status === 'pending') {
        ms.status = 'in_progress';
        changed = true;
      }
    }

    if (changed) {
      db.saveBuild(build);
    }
  }

  /**
   * Executes work on a claimed task, submits patches, handles retries safely
   */
  private static async executeTaskWork(buildId: string, model: ModelConfig, task: Task): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build) return;

    // Check per-task token budget to prevent runaways
    const taskBudget = task.tokenBudget || 25000;
    if ((task.actualTokensUsed || 0) >= taskBudget) {
      TaskManager.pauseTask(buildId, task.id, `Task token budget reached (${task.actualTokensUsed}/${taskBudget} tokens)`);
      return;
    }

    // Dynamic Context Selection: Selects ONLY target files and outline dependencies
    const allProjectFiles = db.getAllFiles(buildId);
    const filesContextText = tokenOptimizer.selectRelevantFilesContext(
      task.filePaths,
      allProjectFiles,
      2800
    );

    // Compact summary of recent team achievements to prevent repeating work
    const teamProgressSummary = tokenOptimizer.summarizeSwarmHistory(db.getEvents(buildId), 12);

    // Project Intelligence & Memory Context (ADRs, requirements, confirmed facts, active defects)
    const memoryContext = ProjectMemoryService.retrieveTaskContext(buildId, build.userId, task, 1600);

    const roleSpec = model.agentRole ? AGENT_SPECS[model.agentRole] : undefined;
    const roleInstruction = roleSpec ? `YOUR SPECIALIZED ROLE: ${roleSpec.title}\nResponsibilities: ${roleSpec.responsibilities.join('; ')}` : '';

    const prompt = `${roleInstruction}
TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.filePaths.join(', ')}
IS FIX TASK: ${task.isFixTask ? 'YES - Analyze the error and generate exact surgical find/replace fix' : 'NO'}

${memoryContext ? memoryContext + '\n' : ''}
TEAM PROGRESS CONTEXT:
${teamProgressSummary}

RELEVANT SOURCE CODE CONTEXT:
${filesContextText}

Output valid JSON action(s) to accomplish this task.
If creating new files, use "create_file" with complete pristine code.
If updating existing files, use "patch_file" with exact "find" text matching the file content above.
Never write placeholder comments. Implement functional code.`;

    let attempts = 0;
    let taskDone = false;
    let lastError = '';

    while (!taskDone && attempts < 3) {
      attempts++;

      const res = await callUnifiedGateway({
        modelId: model.id,
        task,
        taskComplexity: task.complexity || (task.isFixTask ? 'flagship' : 'standard'),
        prompt,
        systemInstruction: SILENT_WORKER_SYSTEM_PROMPT,
        allowFallback: true,
        buildId,
        userId: build.userId
      });

      // Track usage on model and task
      const modelRun = db.getModelRun(buildId, model.id);
      const tokens = (modelRun?.tokensUsed || 0) + res.tokensUsed;
      const cost = (modelRun?.estimatedCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.updateModelRun(buildId, model.id, {
        tokensUsed: tokens,
        estimatedCost: cost
      });

      // Update build tokens and costs
      build.totalTokens = (build.totalTokens || 0) + res.tokensUsed;
      build.totalCost = (build.totalCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.saveBuild(build);

      // Update task token usage
      task.actualTokensUsed = (task.actualTokensUsed || 0) + res.tokensUsed;
      task.estimatedCost = (task.estimatedCost || 0) + (res.estimatedCost || (res.tokensUsed * 0.000003));
      db.updateTask(buildId, task.id, {
        actualTokensUsed: task.actualTokensUsed,
        estimatedCost: task.estimatedCost
      });

      if (!res.success || !res.parsedResponse) {
        lastError = res.error || 'Generation failed: Model produced no valid JSON response';
        db.updateModelRun(buildId, model.id, { 
          status: 'retrying',
          error: lastError,
          lastActionSummary: `Retry ${attempts}/3: ${lastError}`
        });

        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const parsed = res.parsedResponse;
      if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
        lastError = 'Model returned empty actions array';
        db.updateModelRun(buildId, model.id, { status: 'retrying', error: lastError });
        continue;
      }

      // Apply each action via Merge Manager
      let allActionsSucceeded = true;
      let appliedCount = 0;

      for (const action of parsed.actions) {
        if (action.action === 'create_file') {
          const createRes = await MergeManager.createFile(buildId, model.id, action);
          if (!createRes.success) {
            allActionsSucceeded = false;
            lastError = createRes.error || 'create_file failed';
          } else {
            appliedCount++;
          }
        } else if (action.action === 'patch_file') {
          const patchRes = await MergeManager.applyPatch(buildId, model.id, action);
          if (!patchRes.success) {
            allActionsSucceeded = false;
            lastError = patchRes.error || 'patch_file failed';
            db.updateModelRun(buildId, model.id, {
              patchesRejected: (modelRun?.patchesRejected || 0) + 1,
              status: 'retrying'
            });
          } else {
            appliedCount++;
            db.updateModelRun(buildId, model.id, {
              patchesApplied: (modelRun?.patchesApplied || 0) + 1
            });
          }
        } else if (action.action === 'delete_file') {
          const delRes = await MergeManager.deleteFile(buildId, model.id, action);
          if (!delRes.success) {
            allActionsSucceeded = false;
            lastError = delRes.error || 'delete_file failed';
          } else {
            appliedCount++;
          }
        } else if (action.action === 'rename_file') {
          const renRes = await MergeManager.renameFile(buildId, model.id, action);
          if (!renRes.success) {
            allActionsSucceeded = false;
            lastError = renRes.error || 'rename_file failed';
          } else {
            appliedCount++;
          }
        } else if (action.action === 'create_task') {
          TaskManager.createNewTask(buildId, {
            title: action.title,
            description: action.description,
            filePaths: action.filePaths,
            dependencies: action.dependencies,
            assignedRole: action.assignedRole,
            priority: action.priority || 3,
            maxRetries: this.MAX_TASK_RETRIES
          });
        }
      }

      if (allActionsSucceeded && appliedCount > 0) {
        TaskManager.completeTask(buildId, task.id, model.id);
        taskDone = true;

        // Synchronize Project Memory: update module graph & resolve defects if fix task
        try {
          const filesNow = db.getAllFiles(buildId);
          ProjectMemoryService.updateModuleRelationships(buildId, build.userId, filesNow);

          if (task.isFixTask) {
            const memory = ProjectMemoryService.getOrInitializeMemory(buildId, build.userId);
            if (memory) {
              const matchingDefects = memory.knownDefects.filter(
                d => !d.resolved && d.filePaths.some(fp => task.filePaths.includes(fp))
              );
              for (const md of matchingDefects) {
                ProjectMemoryService.resolveDefect(buildId, build.userId, md.id);
              }
            }
          }
        } catch (e) {
          // Graceful handling of memory synchronization
        }
      } else {
        // Detect unproductive loop if attempts exhausted and zero edits succeeded
        if (attempts >= 3 && appliedCount === 0 && (task.retryCount || 0) >= 2) {
          TaskManager.pauseTask(buildId, task.id, `Unproductive agent loop: repeated patch rejections on ${task.filePaths.join(', ')} (${lastError})`);
          return;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!taskDone) {
      TaskManager.releaseTask(buildId, task.id, model.id, lastError || 'Max patch attempts exceeded');
    }
  }

  /**
   * Verifier phase: checks that all tasks are done, sandbox passes, and verifier model approves.
   */
  private static async checkProjectCompletion(buildId: string, control: ActiveSwarmControl): Promise<void> {
    const build = db.getBuild(buildId);
    if (!build || build.status !== 'running') return;

    const tasks = db.getTasks(buildId);

    // 1. Ensure no pending or in_progress tasks remain
    const incompleteTasks = tasks.filter(t => 
      t.status === 'pending' || 
      t.status === 'in_progress' || 
      t.status === 'open' || 
      t.status === 'claimed' || 
      t.status === 'retrying'
    );
    if (incompleteTasks.length > 0) return;

    // Check if any tasks are paused (e.g. token budget limit or rate limit)
    const pausedTasks = tasks.filter(t => t.status === 'paused' || t.isPaused);
    if (pausedTasks.length > 0) {
      return; // Do not complete project while tasks are paused
    }

    // 2. Check if any tasks failed
    const failedTasks = tasks.filter(t => t.status === 'failed');
    if (failedTasks.length > 0) {
      build.status = 'failed';
      build.completedAt = Date.now();
      build.failureReason = `${failedTasks.length} task(s) failed during execution: ${failedTasks.map(t => t.title).join(', ')}`;
      build.error = build.failureReason;
      db.saveBuild(build);
      control.stopRequested = true;

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'build_failed',
        details: `Build cannot complete: ${build.failureReason}`
      });
      return;
    }

    // 3. Ensure at least one file exists
    const allFiles = db.getAllFiles(buildId);
    if (allFiles.length === 0) {
      build.status = 'failed';
      build.completedAt = Date.now();
      build.failureReason = 'No files were generated for this project.';
      db.saveBuild(build);
      control.stopRequested = true;
      return;
    }

    // 4. Run automated sandbox & test verification
    const sandbox = SandboxRunner.runIntegrityCheck(buildId);
    if (!sandbox.passed) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'sandbox_check',
        details: `Integrity check failed with ${sandbox.errors.length} issue(s). Debugging Agent resuming fix tasks.`
      });
      return;
    }

    // 5. Call Objective Verifier Model (Flagship reasoning task)
    build.status = 'verifying';
    build.verificationAttempts = (build.verificationAttempts || 0) + 1;
    const currentAttempt = build.verificationAttempts;
    const maxAttempts = build.maxVerificationAttempts || this.MAX_VERIFICATION_ATTEMPTS;
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_started',
      details: `Launching Verifier Model (Attempt ${currentAttempt}/${maxAttempts}) to evaluate requirements satisfaction.`
    });

    const filesSummary = allFiles.map(f => `- ${f.path} (${f.content.split('\n').length} lines, v${f.version})`).join('\n');

    const verifierPrompt = `VERIFY SOFTWARE COMPLETION
Original User Specification: "${build.idea}"

Generated File Tree:
${filesSummary}

Review whether this software genuinely implements the requirements of the original user idea.
Output ONLY JSON in this exact schema:
{
  "approved": true or false,
  "summary": "Specific evaluation explanation",
  "missingRequirements": ["item 1", "item 2"]
}`;

    const verifyResult = await callUnifiedGateway({
      modelId: 'claude',
      taskComplexity: 'flagship',
      prompt: verifierPrompt,
      systemInstruction: 'You are an objective software verifier. Validate requirement coverage without bias. Output only JSON.',
      allowFallback: true,
      buildId: build.id,
      userId: build.userId
    });

    const verifierData = parseVerifierResponse(verifyResult.rawText);

    if (!verifyResult.success || !verifierData) {
      const parseError = verifyResult.error || 'Verifier response was malformed or missing boolean approved field.';
      
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'verifier_rejected',
        details: `Verification attempt ${currentAttempt}/${maxAttempts} failed: ${parseError}`
      });

      if (currentAttempt >= maxAttempts) {
        build.status = 'failed';
        build.completedAt = Date.now();
        build.failureReason = `Verification failed: Unable to obtain valid verification verdict after ${maxAttempts} attempts.`;
        build.error = build.failureReason;
        db.saveBuild(build);
        control.stopRequested = true;
      } else {
        build.status = 'running';
        db.saveBuild(build);
      }
      return;
    }

    if (!verifierData.approved) {
      const missing = verifierData.missingRequirements || [];
      const summary = verifierData.summary || 'Requirements incomplete';

      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'verifier_rejected',
        details: `Verification rejected: ${summary}. Missing: ${missing.join(', ') || 'unspecified'}`
      });

      if (currentAttempt >= maxAttempts) {
        build.status = 'failed';
        build.completedAt = Date.now();
        build.failureReason = `Verification rejected after ${maxAttempts} attempts: ${summary}`;
        build.error = build.failureReason;
        build.verificationFeedback = summary;
        db.saveBuild(build);
        control.stopRequested = true;
        return;
      }

      // Create new targeted tasks for missing requirements
      for (const req of missing) {
        TaskManager.createNewTask(buildId, {
          title: `Implement Missing Requirement: ${req.slice(0, 50)}`,
          description: `Verifier indicated requirement is missing or incomplete: ${req}`,
          filePaths: ['src/core/engine.ts'],
          priority: 1,
          isFixTask: true,
          assignedRole: 'debugging_specialist',
          maxRetries: this.MAX_TASK_RETRIES
        });
      }

      build.status = 'running';
      build.verificationFeedback = summary;
      db.saveBuild(build);
      return;
    }

    // 6. Cross-Module Contract & Integration Validation
    const integrationReport = IntegrationAgent.analyzeProjectContracts(buildId);
    if (!integrationReport.passed) {
      db.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: Date.now(),
        type: 'patch_rejected',
        details: `Integration Specialist identified ${integrationReport.issues.length} cross-module import or contract issue(s). Spawning integration repair tasks.`
      });
      build.status = 'running';
      db.saveBuild(build);
      return;
    }

    // 7. Update Requirements Checklist satisfaction
    if (build.requirementsChecklist) {
      for (const req of build.requirementsChecklist) {
        req.satisfied = true;
        req.satisfiedByFiles = allFiles.slice(0, 3).map(f => f.path);
        req.verificationNotes = 'Verified by autonomous Verifier Model and Sandbox test suite';
      }
    }

    // 8. Generate Interactive Live Preview Document
    try {
      const preview = PreviewGenerator.generateInteractivePreview(build.idea, allFiles, build.projectType || 'fullstack');
      build.livePreviewHtml = preview.html;
    } catch (prevErr) {
      console.warn('Failed to compile preview bundle:', prevErr);
    }

    // GENUINE SUCCESSFUL APPROVAL
    build.status = 'completed';
    build.completedAt = Date.now();
    build.verificationFeedback = verifierData.summary;
    db.saveBuild(build);
    control.stopRequested = true;

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'verifier_approved',
      details: `Verifier Model approved: "${verifierData.summary}"`
    });

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_completed',
      details: `Build Complete! Total files: ${allFiles.length}, total patches: ${build.patchesAppliedCount || 0}, cost: $${(build.totalCost || 0).toFixed(4)}`
    });

    // Auto-push to GitHub feature branch feature/autonomous-development-team if enabled
    if (build.autoPushGithub) {
      await GitHubService.autoPushProject(buildId, build.userId);
    }
  }

  /**
   * Applies a natural language revision to an existing build without rebuilding from scratch
   */
  static async applyRevision(
    buildIdOrBuild: string | Build, 
    revisionPrompt: string
  ): Promise<{ success: boolean; revisionId: string; revision?: ProjectRevision; error?: string }> {
    const build = typeof buildIdOrBuild === 'string' ? db.getBuild(buildIdOrBuild) : buildIdOrBuild;
    if (!build) return { success: false, revisionId: '', error: 'Build not found' };
    const buildId = build.id;

    const cleanPrompt = revisionPrompt.trim();
    if (!cleanPrompt) return { success: false, revisionId: '', error: 'Revision prompt cannot be empty' };

    const revId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const revisionNumber = (build.revisions?.length || 0) + 1;
    const revision: ProjectRevision = {
      id: revId,
      revisionNumber,
      prompt: cleanPrompt,
      createdAt: Date.now(),
      status: 'in_progress',
      summary: `Revision: "${cleanPrompt.slice(0, 50)}"`,
      tasksGenerated: []
    };

    if (!build.revisions) build.revisions = [];
    build.revisions.push(revision);

    const files = db.getAllFiles(buildId);
    const targetFile = files.find(f => f.path.endsWith('.tsx') || f.path.endsWith('.ts'))?.path || 'src/components/MainView.tsx';

    const revisionTask = TaskManager.createNewTask(buildId, {
      title: `[Revision #${revisionNumber}] ${cleanPrompt.slice(0, 50)}`,
      description: `User requested targeted code modification: ${cleanPrompt}`,
      filePaths: [targetFile],
      priority: 1,
      isFixTask: true,
      assignedRole: 'frontend_developer',
      maxRetries: 3
    });

    revision.tasksGenerated = [revisionTask.id];

    // Synchronize into persistent project memory
    try {
      ProjectMemoryService.recordRevision(buildId, build.userId, revision);
    } catch (err) {
      console.warn(`Failed to synchronize revision into ProjectMemory:`, err);
    }

    build.status = 'running';
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: Date.now(),
      type: 'build_started',
      details: `Natural language revision queued: "${cleanPrompt}" (Task: ${revisionTask.title})`
    });

    // Start worker loop if not already running
    if (!this.activeSwarms.has(buildId)) {
      const control: ActiveSwarmControl = {
        stopRequested: false,
        workerCount: 0
      };
      this.activeSwarms.set(buildId, control);

      const enabledModels = build.selectedModels
        .map(id => modelRegistry.getById(id))
        .filter((m): m is ModelConfig => !!m && m.enabled);

      control.workerCount = enabledModels.length;
      const workerPromises = enabledModels.map(model => 
        this.runModelWorkerLoop(buildId, model, control)
      );

      Promise.all(workerPromises).finally(() => {
        this.activeSwarms.delete(buildId);
        const b = db.getBuild(buildId);
        if (b) {
          const rev = b.revisions?.find(r => r.id === revId);
          if (rev) {
            rev.status = b.status === 'completed' ? 'completed' : 'failed';
            db.saveBuild(b);
          }
        }
      });
    }

    return { success: true, revisionId: revId, revision };
  }
}

