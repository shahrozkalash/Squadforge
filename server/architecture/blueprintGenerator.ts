import { 
  RequirementsAnalysis, 
  StackSelectionResult, 
  ArchitectureBlueprint, 
  ArchitectureLayer, 
  ArchitectureModule, 
  ApiContract, 
  DataFlowStep, 
  SecurityBoundary, 
  ArchitectureRisk,
  CanonicalProjectType,
  TargetPlatform
} from '../types.js';

export class UniversalArchitectureBlueprintGenerator {
  /**
   * Generates a comprehensive, structured architecture blueprint tailored to the project.
   * Only includes relevant architectural layers and subsystems (e.g. no DB for purely static sites,
   * no web frontend for pure CLI or headless API daemons).
   */
  static generate(
    analysis: RequirementsAnalysis, 
    stackResult: StackSelectionResult
  ): ArchitectureBlueprint {
    const { 
      applicationCategory, 
      targetPlatforms, 
      mainPurpose, 
      originalPrompt, 
      confirmedRequirements, 
      externalIntegrations,
      securityRequirements 
    } = analysis;

    const stack = stackResult.recommendedStack;

    // 1. Technology decisions mapping
    const technologyDecisions: Record<string, string> = {
      primaryLanguage: stack.primaryLanguage,
      selectedStackName: stack.name
    };
    if (stack.frontend) technologyDecisions.frontend = stack.frontend;
    if (stack.backend) technologyDecisions.backend = stack.backend;
    if (stack.desktopFramework) technologyDecisions.desktopFramework = stack.desktopFramework;
    if (stack.mobileFramework) technologyDecisions.mobileFramework = stack.mobileFramework;
    if (stack.database) technologyDecisions.database = stack.database;
    if (stack.runtime) technologyDecisions.runtime = stack.runtime;
    if (stack.buildTool) technologyDecisions.buildTool = stack.buildTool;
    if (stack.testing) technologyDecisions.testing = stack.testing;

    // 2. Determine Application Layers
    const applicationLayers = this.deriveLayers(applicationCategory, stack, targetPlatforms);

    // 3. Module Structure & Subsystems
    const moduleStructure = this.deriveModules(applicationCategory, stack, confirmedRequirements);

    // 4. Component Responsibilities
    const componentResponsibilities: Record<string, string[]> = {};
    for (const mod of moduleStructure) {
      componentResponsibilities[mod.name] = mod.responsibilities;
    }

    // 5. Frontend Architecture (where applicable)
    const frontendArchitecture = this.deriveFrontendArchitecture(applicationCategory, stack);

    // 6. Backend Architecture (where applicable)
    const backendArchitecture = this.deriveBackendArchitecture(applicationCategory, stack);

    // 7. Database Architecture (where applicable)
    const databaseArchitecture = this.deriveDatabaseArchitecture(applicationCategory, stack);

    // 8. API Contracts (where applicable)
    const apiContracts = this.deriveApiContracts(applicationCategory, confirmedRequirements);

    // 9. Data Flow
    const dataFlow = this.deriveDataFlow(applicationCategory, stack);

    // 10. Auth Requirements
    const hasAuth = /\b(auth|login|signup|user account|session|jwt|oauth|credentials)\b/i.test(originalPrompt) ||
                    applicationCategory === 'saas' || applicationCategory === 'ecommerce';
    const authRequirements = hasAuth ? {
      mechanism: 'Secure HTTP-only session cookies with bcryptjs password hashing and rate-limited brute-force guards',
      roles: ['guest', 'user', 'admin'],
      tokenHandling: 'Server-side cryptographic token verification with SHA-256 session table indexing'
    } : undefined;

    // 11. File Storage Requirements
    const fileStorageRequirements = /\b(file|photo|image|upload|attachment|document|export)\b/i.test(originalPrompt) ? {
      strategy: applicationCategory.includes('desktop') ? 'Local OS file system access with path sanitization' : 'Sandboxed multipart parser with size quotas and MIME-type verification',
      allowedFormats: ['png', 'jpg', 'jpeg', 'json', 'csv', 'txt'],
      maxSizeBytes: 10 * 1024 * 1024 // 10MB
    } : undefined;

    // 12. Security Boundaries
    const securityBoundaries = this.deriveSecurityBoundaries(applicationCategory, targetPlatforms);

    // 13. Testing Strategy
    const testingStrategy = {
      unit: stack.testing || 'Native automated unit test runner',
      integration: 'End-to-end subsystem integration and API contract verification',
      e2e: targetPlatforms.includes('web') ? 'Headless browser runtime DOM verification' : 'Native executable process verification',
      automatedCoverageGoalPercent: 85
    };

    // 14. Build Strategy
    const buildStrategy = {
      tool: stack.buildTool || 'esbuild / Vite',
      artifactType: targetPlatforms.includes('windows') && !targetPlatforms.includes('web') ? 'Windows Executable (.exe)'
        : targetPlatforms.includes('android') ? 'Android Application Package (.apk)'
        : targetPlatforms.includes('cli') ? 'Compiled Command-Line Binary'
        : 'Production Static & Server Bundle',
      productionCommand: stack.buildTool?.includes('cargo') ? 'cargo build --release'
        : stack.buildTool?.includes('dotnet') ? 'dotnet publish -c Release'
        : stack.buildTool?.includes('Gradle') ? './gradlew assembleRelease'
        : 'npm run build'
    };

    // 15. Deployment Strategy
    const deploymentStrategy = {
      target: targetPlatforms.includes('windows') ? 'Windows 10/11 Local Environment'
        : targetPlatforms.includes('android') ? 'Android OS Device / Emulator'
        : targetPlatforms.includes('cli') ? 'Standard Terminal Environment'
        : 'Docker Container / Cloud Web Service',
      containerized: targetPlatforms.includes('web') || targetPlatforms.includes('cloud'),
      configFiles: targetPlatforms.includes('web') ? ['Dockerfile', 'vite.config.ts', 'tsconfig.json'] : ['package.json']
    };

    // 16. Architecture Risks
    const architectureRisks = this.deriveArchitectureRisks(applicationCategory, stackResult);

    // 17. Technical Assumptions
    const technicalAssumptions = [
      `Application operates within specified platform constraints for ${targetPlatforms.join(', ')}`,
      `Zero untrusted input is processed without strict defensive sanitization`,
      `State transitions follow unidirectional predictable flow`,
      `Module interfaces adhere to strict typing contracts without implicit any`
    ];

    return {
      projectClassification: applicationCategory,
      projectSummary: mainPurpose,
      targetPlatforms,
      technologyDecisions,
      applicationLayers,
      moduleStructure,
      componentResponsibilities,
      frontendArchitecture,
      backendArchitecture,
      databaseArchitecture,
      apiContracts,
      dataFlow,
      authRequirements,
      fileStorageRequirements,
      externalIntegrations,
      errorHandlingStrategy: 'Centralized error boundary and defensive validation traps ensuring process and UI continuity without crashes',
      securityBoundaries,
      testingStrategy,
      buildStrategy,
      deploymentStrategy,
      architectureRisks,
      technicalAssumptions,
      generatedAt: Date.now()
    };
  }

  private static deriveLayers(
    category: CanonicalProjectType, 
    stack: any, 
    platforms: TargetPlatform[]
  ): ArchitectureLayer[] {
    const layers: ArchitectureLayer[] = [];

    // Presentation / UI Layer
    if (!category.includes('cli') && category !== 'api_service' && category !== 'backend_service') {
      layers.push({
        name: 'Presentation & UI Layer',
        responsibility: 'User interface components, responsive layout, user interaction handlers, and client state orchestration',
        components: ['Navigation', 'Views / Pages', 'Modals & Drawers', 'Form Controls', 'Visual Indicators'],
        technologies: [stack.frontend || stack.uiFramework || stack.desktopFramework || 'UI Component System']
      });
    }

    // Application & Business Logic Layer
    layers.push({
      name: 'Domain & Business Logic Layer',
      responsibility: 'Core domain models, state management, transaction workflows, calculation algorithms, and business rule enforcement',
      components: ['Domain Models', 'State Store', 'Workflow Controllers', 'Validation Rules'],
      technologies: [stack.primaryLanguage, 'Domain Interfaces']
    });

    // Native Bridge / IPC Layer (for Desktop & Mobile)
    if (category.includes('desktop') || category.includes('windows') || category.includes('mobile') || category.includes('android')) {
      layers.push({
        name: 'Platform & Hardware Bridge Layer',
        responsibility: 'OS native lifecycle events, local file system I/O, device hardware access, window frame management, and inter-process communication',
        components: ['IPC Protocol Bridge', 'File System Gateway', 'OS Notification Bridge', 'Window Lifecycle Manager'],
        technologies: [stack.desktopFramework || stack.mobileFramework || 'Native OS Runtime']
      });
    }

    // Backend / Service Layer (for Web Fullstack & APIs)
    if (category === 'fullstack' || category === 'saas' || category === 'ecommerce' || category === 'api_service' || category === 'backend_service') {
      layers.push({
        name: 'API & Gateway Service Layer',
        responsibility: 'REST/RPC endpoints, HTTP routing, security header enforcement, rate limiting, and request lifecycle management',
        components: ['API Route Handlers', 'Authentication Middleware', 'Input Sanitizer', 'Audit Logger'],
        technologies: [stack.backend || 'Express / HTTP Server Engine']
      });
    }

    // Data Storage & Persistence Layer
    if (category !== 'landing_page' && category !== 'portfolio') {
      layers.push({
        name: 'Persistence & Data Access Layer',
        responsibility: 'Durable entity storage, atomic transactions, schema migrations, and fast indexed retrieval',
        components: ['Database Manager', 'Migration Engine', 'Entity Repositories', 'In-Memory Cache'],
        technologies: [stack.database || 'SQLite / Entity Store']
      });
    }

    return layers;
  }

  private static deriveModules(
    category: CanonicalProjectType, 
    stack: any, 
    requirements: any[]
  ): ArchitectureModule[] {
    const modules: ArchitectureModule[] = [];

    // Core Domain Module (All systems)
    modules.push({
      id: 'mod_core_domain',
      name: 'Core Domain Subsystem',
      description: 'Domain interfaces, data structures, and foundational validation logic',
      layer: 'Domain & Business Logic Layer',
      responsibilities: [
        'Define immutable domain entities and transfer schemas',
        'Enforce business validation rules on domain operations',
        'Provide serialization and deserialization helpers'
      ],
      files: ['src/types/domain.ts', 'src/domain/validator.ts'],
      dependencies: [],
      exports: ['Domain Models', 'Validation Schemas']
    });

    // UI Modules if not headless
    if (!category.includes('cli') && category !== 'api_service' && category !== 'backend_service') {
      modules.push({
        id: 'mod_ui_views',
        name: 'User Interface View System',
        description: 'Interactive presentation views, responsive layout shells, and stateful widgets',
        layer: 'Presentation & UI Layer',
        responsibilities: [
          'Render accessible visual components',
          'Handle user input events and dispatch state actions',
          'Display asynchronous loading indicators and error states'
        ],
        files: ['src/App.tsx', 'src/components/MainView.tsx', 'src/components/Navbar.tsx'],
        dependencies: ['Core Domain Subsystem'],
        exports: ['MainApplicationComponent', 'ViewComponents']
      });
    }

    // Platform Bridge for Desktop / Mobile
    if (category.includes('desktop') || category.includes('windows')) {
      modules.push({
        id: 'mod_native_platform',
        name: 'Native Desktop Shell & File Bridge',
        description: 'Manages window state, native dialogs, and secure OS file interactions',
        layer: 'Platform & Hardware Bridge Layer',
        responsibilities: [
          'Handle window minimize, maximize, and close events',
          'Provide secure file open/save dialogs with path sanitization',
          'Bridge background thread operations without blocking UI'
        ],
        files: ['src/platform/nativeBridge.ts', 'src/platform/fileOperations.ts'],
        dependencies: ['Core Domain Subsystem'],
        exports: ['NativeBridgeAPI', 'FileDialogHelpers']
      });
    }

    // Backend / Service module if server is required
    if (category === 'fullstack' || category === 'saas' || category === 'ecommerce' || category === 'api_service' || category === 'backend_service') {
      modules.push({
        id: 'mod_api_service',
        name: 'REST API & Router Subsystem',
        description: 'Handles client HTTP requests, route dispatch, authentication validation, and response formatting',
        layer: 'API & Gateway Service Layer',
        responsibilities: [
          'Validate incoming request payloads against schemas',
          'Orchestrate domain operations and database queries',
          'Emit structured errors and security audit records'
        ],
        files: ['server.ts', 'server/routes.ts'],
        dependencies: ['Core Domain Subsystem', 'Persistence & Storage Subsystem'],
        exports: ['ExpressAppInstance', 'ApiRoutes']
      });

      modules.push({
        id: 'mod_persistence',
        name: 'Persistence & Storage Subsystem',
        description: 'Database connection pooling, schema migrations, and transaction coordination',
        layer: 'Persistence & Data Access Layer',
        responsibilities: [
          'Execute atomic database read/write queries',
          'Manage schema migrations and indices',
          'Provide in-memory caching to minimize I/O overhead'
        ],
        files: ['server/db/database.ts', 'server/store.ts'],
        dependencies: ['Core Domain Subsystem'],
        exports: ['DatabaseManager', 'DataStore']
      });
    }

    // QA & Verification Module
    modules.push({
      id: 'mod_testing_qa',
      name: 'Automated Testing & QA Verification Subsystem',
      description: 'End-to-end automated test suites, property testing, and regression guards',
      layer: 'Domain & Business Logic Layer',
      responsibilities: [
        'Execute deterministic unit tests validating all domain logic',
        'Verify error recovery pathways and boundary conditions',
        'Ensure continuous regression immunity'
      ],
      files: ['tests/domain.test.ts', 'tests/integration.test.ts'],
      dependencies: ['Core Domain Subsystem'],
      exports: ['TestSuiteRunner']
    });

    return modules;
  }

  private static deriveFrontendArchitecture(category: CanonicalProjectType, stack: any) {
    if (category.includes('cli') || category === 'api_service' || category === 'backend_service') {
      return undefined;
    }
    return {
      framework: stack.frontend || stack.uiFramework || 'React 19 with TypeScript',
      routing: 'Client-side route state / modular tab navigation',
      stateManagement: 'React Context API + Custom Hooks with immutable dispatch',
      styling: 'Semantic Tailwind CSS with neutral dark mode and responsive breakpoints',
      responsiveBreakpoints: ['mobile (< 640px)', 'tablet (640px - 1024px)', 'desktop (> 1024px)']
    };
  }

  private static deriveBackendArchitecture(category: CanonicalProjectType, stack: any) {
    if (category === 'landing_page' || category === 'portfolio') {
      return undefined;
    }
    return {
      framework: stack.backend || stack.desktopFramework || 'Node.js Express + TypeScript Server API',
      pattern: 'Controller-Service-Repository pattern with defensive input validation',
      apiStyle: category.includes('desktop') ? ('ipc' as const) : category.includes('cli') ? ('cli' as const) : ('rest' as const),
      endpoints: [
        '/healthz',
        '/readyz',
        '/api/health',
        '/api/items',
        '/api/config'
      ]
    };
  }

  private static deriveDatabaseArchitecture(category: CanonicalProjectType, stack: any) {
    if (category === 'landing_page' || category === 'portfolio' || category === 'cli_tool') {
      return undefined;
    }
    return {
      engine: stack.database || 'SQLite Persistent Database (Node.js 22 built-in node:sqlite)',
      paradigm: 'relational' as const,
      schemaSummary: 'Normalized schema with primary keys, foreign key constraints, atomic transactions, and indexed timestamps'
    };
  }

  private static deriveApiContracts(category: CanonicalProjectType, requirements: any[]): ApiContract[] {
    if (category.includes('cli') || category === 'landing_page' || category === 'portfolio') {
      return [];
    }

    return [
      {
        endpoint: '/healthz',
        method: 'GET',
        description: 'Liveness probe verifying that the host application process is alive and responsive',
        responsePayload: '{ status: "healthy", uptimeSeconds: number, timestamp: number }'
      },
      {
        endpoint: '/api/health',
        method: 'GET',
        description: 'Deep health diagnostic verifying storage accessibility and provider status',
        responsePayload: '{ status: "healthy" | "degraded", storage: string, timestamp: number }'
      },
      {
        endpoint: '/api/data',
        method: 'GET',
        description: 'Retrieves primary domain entities with optional filtering and pagination',
        responsePayload: '{ success: boolean, items: Array<DomainItem>, total: number }'
      },
      {
        endpoint: '/api/data',
        method: 'POST',
        description: 'Creates a new domain entity with defensive schema validation',
        requestPayload: '{ name: string, payload: Record<string, any> }',
        responsePayload: '{ success: boolean, item: DomainItem }'
      }
    ];
  }

  private static deriveDataFlow(category: CanonicalProjectType, stack: any): DataFlowStep[] {
    if (category.includes('cli')) {
      return [
        { step: 1, from: 'Terminal Invocation', to: 'CLI Argument Parser', data: 'Command line flags & arguments', mechanism: 'process.argv standard input' },
        { step: 2, from: 'CLI Argument Parser', to: 'Domain Command Handler', data: 'Parsed command options & parameters', mechanism: 'Direct function invocation' },
        { step: 3, from: 'Domain Command Handler', to: 'Output Formatter', data: 'Computed results or error state', mechanism: 'Structured return' },
        { step: 4, from: 'Output Formatter', to: 'Standard Streams', data: 'Formatted text / JSON output', mechanism: 'process.stdout / process.stderr' }
      ];
    }

    if (category.includes('desktop') || category.includes('windows')) {
      return [
        { step: 1, from: 'User UI Action', to: 'View Component Controller', data: 'User click, keyboard input, or file drop', mechanism: 'DOM event listener' },
        { step: 2, from: 'View Component Controller', to: 'Platform Native Bridge', data: 'Sanitized operation command', mechanism: 'Secure IPC invoke' },
        { step: 3, from: 'Platform Native Bridge', to: 'OS Subsystem / File System', data: 'File path, binary payload, or window event', mechanism: 'Native API dispatch' },
        { step: 4, from: 'OS Subsystem', to: 'UI State Store', data: 'Completed operation result or status code', mechanism: 'Asynchronous promise resolution' }
      ];
    }

    return [
      { step: 1, from: 'Client User Interface', to: 'API Gateway / Server', data: 'HTTP Request with JSON payload & auth cookie', mechanism: 'fetch() over HTTPS / HTTP' },
      { step: 2, from: 'API Gateway / Server', to: 'Validation & Security Filter', data: 'Request parameters & headers', mechanism: 'Middleware interceptor' },
      { step: 3, from: 'Validation & Security Filter', to: 'Domain Service Layer', data: 'Sanitized typed domain request', mechanism: 'Service call' },
      { step: 4, from: 'Domain Service Layer', to: 'Database Storage', data: 'SQL query with parameter bindings', mechanism: 'Prepared transaction' },
      { step: 5, from: 'Database Storage', to: 'Client Presentation Layer', data: 'JSON response body with updated entity data', mechanism: 'HTTP Response stream' }
    ];
  }

  private static deriveSecurityBoundaries(category: CanonicalProjectType, platforms: TargetPlatform[]): SecurityBoundary[] {
    const boundaries: SecurityBoundary[] = [
      {
        name: 'Public Untrusted Boundary',
        trustZone: 'public',
        controls: [
          'Defensive schema sanitization rejecting malformed payloads',
          'Strict character whitelist validation on file paths',
          'Rate limiting per IP address to mitigate brute-force attempts'
        ]
      },
      {
        name: 'Internal Storage & File Boundary',
        trustZone: 'storage',
        controls: [
          'Path traversal prevention: strictly disallowing "..", null bytes, and absolute escapes',
          'File size caps and project-wide byte quotas',
          'Prepared parameter binding preventing SQL injection attacks'
        ]
      }
    ];

    if (platforms.includes('windows') || platforms.includes('macos') || platforms.includes('linux')) {
      boundaries.push({
        name: 'Native Operating System Boundary',
        trustZone: 'native_os',
        controls: [
          'Isolated context execution preventing arbitrary command execution',
          'Strict sanitization of shell argument vectors',
          'Elevated permissions avoided for standard user workflows'
        ]
      });
    }

    return boundaries;
  }

  private static deriveArchitectureRisks(category: CanonicalProjectType, stackResult: StackSelectionResult): ArchitectureRisk[] {
    const risks: ArchitectureRisk[] = [];
    let idx = 1;

    if (stackResult.compatibilityWarnings.length > 0) {
      for (const warn of stackResult.compatibilityWarnings) {
        risks.push({
          id: `risk_${idx++}`,
          title: 'Platform Toolchain & Compatibility Constraint',
          severity: 'high',
          mitigation: warn
        });
      }
    }

    risks.push({
      id: `risk_${idx++}`,
      title: 'State Mutation Concurrency',
      severity: 'medium',
      mitigation: 'Enforce atomic transaction boundaries and sequential patch coordination across development loops.'
    });

    if (category.includes('3d') || category.includes('creative')) {
      risks.push({
        id: `risk_${idx++}`,
        title: 'GPU Memory & Frame Rate Degradation',
        severity: 'medium',
        mitigation: 'Implement geometry instancing, texture mipmapping, and explicit memory disposal on unmount.'
      });
    }

    return risks;
  }
}
