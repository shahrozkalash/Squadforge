import { 
  CanonicalProjectType, 
  TargetPlatform, 
  TechStackBlueprint, 
  FileStructurePlan, 
  PlannedDirectory, 
  PlannedFile 
} from '../types.js';

export class AdaptiveFileStructurePlanner {
  /**
   * Plans an idiomatic file and directory structure reflecting the chosen project category,
   * target platform, and technology stack.
   */
  static planStructure(
    category: CanonicalProjectType, 
    platforms: TargetPlatform[], 
    stack: TechStackBlueprint
  ): FileStructurePlan {
    if (category === 'windows_application' || category === 'desktop_application' || category === 'cross_platform_desktop') {
      return this.planDesktopStructure(category, stack);
    }
    if (category === 'android_application' || category === 'cross_platform_mobile') {
      return this.planMobileStructure(category, stack);
    }
    if (category === 'cli_tool' || category === 'automation_tool' || category === 'developer_tool') {
      return this.planCliToolStructure(category, stack);
    }
    if (category === '3d_application' || category === 'creative_application' || category === 'multimedia_application') {
      return this.planCreative3DStructure(category, stack);
    }
    if (category === 'api_service' || category === 'backend_service') {
      return this.planBackendStructure(category, stack);
    }
    if (category === 'landing_page' || category === 'portfolio' || category === 'blog') {
      return this.planContentWebStructure(category, stack);
    }

    // Default: Full-stack web application
    return this.planFullstackWebStructure(category, stack);
  }

  private static planDesktopStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const isWpf = stack.primaryLanguage === 'C#' || stack.desktopFramework?.includes('WPF');
    const isTauri = stack.desktopFramework?.includes('Tauri');

    if (isWpf) {
      const rootDirectories: PlannedDirectory[] = [
        { path: 'src/AppShell', purpose: 'WPF Application entry point, App.xaml, and main window lifecycle' },
        { path: 'src/Views', purpose: 'XAML view documents and UserControls for user interface screens' },
        { path: 'src/ViewModels', purpose: 'MVVM presentation state and Command bindings' },
        { path: 'src/Models', purpose: 'Domain entities, data contracts, and file system abstractions' },
        { path: 'src/Services', purpose: 'Native Windows platform integration and storage operations' },
        { path: 'tests', purpose: 'xUnit automated test suite verifying business logic and state' }
      ];

      const suggestedFiles: PlannedFile[] = [
        { path: 'src/AppShell/App.xaml.cs', responsibility: 'Application startup, dependency injection container, and unhandled exception trap', role: 'software_architect', priority: 1 },
        { path: 'src/AppShell/MainWindow.xaml', responsibility: 'Main window frame, system menu bar, and visual view host', role: 'frontend_developer', priority: 2 },
        { path: 'src/Models/DomainModels.cs', responsibility: 'Strongly typed domain models and serialization contracts', role: 'software_architect', priority: 1 },
        { path: 'src/Services/FileStorageService.cs', responsibility: 'Path-safe file read/write operations and local settings persistence', role: 'backend_developer', priority: 2 },
        { path: 'tests/DomainModelTests.cs', responsibility: 'Automated test suite asserting model validation and transformations', role: 'qa_testing_specialist', priority: 3 },
        { path: 'Project.csproj', responsibility: '.NET project file with target framework and NuGet package references', role: 'software_architect', priority: 1 }
      ];

      return {
        rootDirectories,
        suggestedFiles,
        ecosystemConventions: [
          'MVVM (Model-View-ViewModel) architectural pattern',
          'Strict nullable reference types enabled in C#',
          'Async/await on all native disk and network I/O operations'
        ]
      };
    }

    // Tauri or Electron Desktop
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/shell', purpose: 'Desktop window frame, native menus, and main process lifecycle' },
      { path: 'src/platform', purpose: 'Secure IPC communication bridge between frontend and native OS' },
      { path: 'src/components', purpose: 'UI view components, layouts, and interactive controls' },
      { path: 'src/domain', purpose: 'Business logic, document models, and state reducers' },
      { path: 'src/storage', purpose: 'Local embedded SQLite storage and settings persistence' },
      { path: 'tests', purpose: 'Automated unit and integration test suite' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/platform/nativeBridge.ts', responsibility: 'Secure typed IPC gateway exposing sanitized native capabilities', role: 'software_architect', priority: 1 },
      { path: 'src/domain/types.ts', responsibility: 'Domain entity contracts, events, and validation schemas', role: 'software_architect', priority: 1 },
      { path: 'src/components/MainWindow.tsx', responsibility: 'Main responsive desktop window UI and workspace layout', role: 'frontend_developer', priority: 2 },
      { path: 'src/storage/localStore.ts', responsibility: 'Atomic local state persistence and configuration store', role: 'backend_developer', priority: 2 },
      { path: 'tests/desktop.test.ts', responsibility: 'Automated tests validating state transitions and IPC protocol schemas', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Strict context isolation between webview and host operating system',
        'No direct Node.js execution in renderer context without IPC validation',
        'Defensive file path sanitization preventing directory traversal'
      ]
    };
  }

  private static planMobileStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const isKotlin = stack.primaryLanguage === 'Kotlin';

    if (isKotlin) {
      const rootDirectories: PlannedDirectory[] = [
        { path: 'app/src/main/java/com/squadforge/app/ui', purpose: 'Jetpack Compose screens, theme, and composable widgets' },
        { path: 'app/src/main/java/com/squadforge/app/domain', purpose: 'Domain models, use cases, and repository interfaces' },
        { path: 'app/src/main/java/com/squadforge/app/data', purpose: 'Room Database, DAOs, and network clients' },
        { path: 'app/src/test/java/com/squadforge/app', purpose: 'JUnit 5 unit tests for viewmodels and domain logic' }
      ];

      const suggestedFiles: PlannedFile[] = [
        { path: 'app/src/main/java/com/squadforge/app/MainActivity.kt', responsibility: 'Android Activity entry point hosting Compose Navigation', role: 'software_architect', priority: 1 },
        { path: 'app/src/main/java/com/squadforge/app/domain/Models.kt', responsibility: 'Kotlin data classes representing domain models', role: 'software_architect', priority: 1 },
        { path: 'app/src/main/java/com/squadforge/app/ui/HomeScreen.kt', responsibility: 'Primary Compose screen with stateful interaction controls', role: 'frontend_developer', priority: 2 },
        { path: 'app/src/main/java/com/squadforge/app/data/AppDatabase.kt', responsibility: 'Room database definition and entity DAOs', role: 'database_specialist', priority: 2 },
        { path: 'app/src/test/java/com/squadforge/app/DomainTest.kt', responsibility: 'Automated test suite asserting business logic correctness', role: 'qa_testing_specialist', priority: 3 },
        { path: 'build.gradle.kts', responsibility: 'Gradle build script defining dependencies and Android SDK targets', role: 'software_architect', priority: 1 }
      ];

      return {
        rootDirectories,
        suggestedFiles,
        ecosystemConventions: [
          'Android architecture guidelines with unidirectional data flow (UDF)',
          'Declarative UI with Jetpack Compose Material 3',
          'Kotlin Coroutines and Flow for asynchronous data streams'
        ]
      };
    }

    // React Native Mobile
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/app', purpose: 'File-based navigation routes and screen containers' },
      { path: 'src/components', purpose: 'Reusable mobile touch-optimized UI components' },
      { path: 'src/services', purpose: 'API client, device permissions, and network handlers' },
      { path: 'src/storage', purpose: 'Local SQLite / persistent mobile storage' },
      { path: 'tests', purpose: 'Mobile automated unit and integration tests' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/app/index.tsx', responsibility: 'Main landing mobile screen with navigation links', role: 'frontend_developer', priority: 1 },
      { path: 'src/types/mobile.ts', responsibility: 'Screen props, domain contracts, and navigation types', role: 'software_architect', priority: 1 },
      { path: 'src/services/apiClient.ts', responsibility: 'Mobile API client with timeout and offline recovery handling', role: 'backend_developer', priority: 2 },
      { path: 'tests/mobile.test.ts', responsibility: 'Automated tests validating screen state and data flow', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Touch target minimum 48x48dp for mobile accessibility',
        'Safe area insets handling for notches and system gestures',
        'Offline-first caching and graceful connectivity degradations'
      ]
    };
  }

  private static planCliToolStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/cli', purpose: 'Command-line entry point, flag definitions, and help manual' },
      { path: 'src/commands', purpose: 'Individual modular command implementations' },
      { path: 'src/core', purpose: 'Core computational logic, data transforms, and engine processing' },
      { path: 'src/io', purpose: 'Input/output stream handling, terminal formatting, and file I/O' },
      { path: 'tests', purpose: 'Automated test suite asserting CLI outputs and exit codes' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/cli/index.ts', responsibility: 'CLI parser entry point, argument parsing, and command routing', role: 'software_architect', priority: 1 },
      { path: 'src/core/types.ts', responsibility: 'Domain options, configuration schemas, and data structures', role: 'software_architect', priority: 1 },
      { path: 'src/commands/execute.ts', responsibility: 'Primary command execution logic and pipeline processing', role: 'backend_developer', priority: 2 },
      { path: 'src/io/formatter.ts', responsibility: 'Rich terminal output formatting, tables, and JSON serialization', role: 'frontend_developer', priority: 2 },
      { path: 'tests/cli.test.ts', responsibility: 'Automated tests asserting flag validation and error exit codes', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'POSIX command-line standard compliance (exit code 0 for success, non-zero for errors)',
        'Support for machine-readable --json output flags',
        'Graceful cancellation handling on SIGINT / Ctrl+C'
      ]
    };
  }

  private static planCreative3DStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/rendering', purpose: '3D scene hierarchy, cameras, render loops, and lighting rigs' },
      { path: 'src/models', purpose: 'Geometry meshes, procedural primitives, and shader materials' },
      { path: 'src/controllers', purpose: 'Orbit controls, viewport interaction, and mouse/touch picking' },
      { path: 'src/ui', purpose: 'Overlay HUD, scene parameter controls, and asset inspectors' },
      { path: 'src/assets', purpose: 'Shaders, textures, and 3D asset loaders' },
      { path: 'tests', purpose: 'Automated tests asserting 3D math and state integrity' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/rendering/SceneEngine.ts', responsibility: 'WebGL/WebGPU renderer lifecycle, scene graph, and animation loop', role: 'software_architect', priority: 1 },
      { path: 'src/models/geometry.ts', responsibility: 'Procedural 3D mesh definitions and material configurations', role: 'software_architect', priority: 2 },
      { path: 'src/controllers/ViewportControls.ts', responsibility: 'Camera orbit, panning, zooming, and spatial raycasting', role: 'frontend_developer', priority: 2 },
      { path: 'src/ui/ControlPanel.tsx', responsibility: 'Interactive parameter adjustment panel and FPS telemetry', role: 'frontend_developer', priority: 3 },
      { path: 'tests/scene.test.ts', responsibility: 'Automated tests asserting vector transforms and scene graph mutations', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Strict GPU resource disposal on component unmount to prevent memory leaks',
        'Separation of continuous render loop from React component re-render cycle',
        'Fallbacks for client devices lacking WebGL 2.0 or hardware acceleration'
      ]
    };
  }

  private static planBackendStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/routes', purpose: 'API route controllers and HTTP method dispatch' },
      { path: 'src/services', purpose: 'Business logic services and external integration adapters' },
      { path: 'src/models', purpose: 'Domain schemas, validation types, and transfer objects' },
      { path: 'src/db', purpose: 'Database connection, schema migrations, and query repositories' },
      { path: 'src/middleware', purpose: 'Authentication, logging, rate limiting, and error guards' },
      { path: 'tests', purpose: 'API contract verification and integration tests' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/server.ts', responsibility: 'Express / HTTP application bootstrapping, middleware mounting, and port binding', role: 'software_architect', priority: 1 },
      { path: 'src/models/schema.ts', responsibility: 'Zod/TypeScript input validation schemas and domain models', role: 'software_architect', priority: 1 },
      { path: 'src/routes/api.ts', responsibility: 'HTTP route handlers with defensive schema parsing and error handling', role: 'backend_developer', priority: 2 },
      { path: 'src/db/database.ts', responsibility: 'Atomic database transaction runner and connection lifecycle', role: 'database_specialist', priority: 2 },
      { path: 'tests/api.test.ts', responsibility: 'Automated tests asserting API contract payloads and status codes', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Controller-Service-Repository structural separation',
        'Defensive input validation rejecting all unvalidated request bodies',
        'Zero leaked internal stack traces in public error responses'
      ]
    };
  }

  private static planContentWebStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/components', purpose: 'Presentation components (Hero, Features, Pricing, Testimonials)' },
      { path: 'src/content', purpose: 'Structured content records, markdown documents, and copy' },
      { path: 'src/types', purpose: 'Type definitions and content schema interfaces' },
      { path: 'tests', purpose: 'Automated accessibility and unit tests' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/App.tsx', responsibility: 'Root layout with responsive navbar, hero section, and interactive sections', role: 'frontend_developer', priority: 1 },
      { path: 'src/types/content.ts', responsibility: 'Strict TypeScript interfaces for marketing and page content', role: 'software_architect', priority: 1 },
      { path: 'src/components/Hero.tsx', responsibility: 'Responsive Hero Banner with value proposition and CTA button', role: 'frontend_developer', priority: 2 },
      { path: 'src/components/FeatureGrid.tsx', responsibility: 'Feature showcase grid with iconography and descriptions', role: 'frontend_developer', priority: 2 },
      { path: 'tests/content.test.ts', responsibility: 'Automated tests verifying responsive layout markup and content completeness', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Semantic HTML5 structure (<header>, <main>, <section>, <footer>)',
        'Zero-runtime Tailwind CSS utility styling with accessible contrast',
        'Mobile-first responsive design'
      ]
    };
  }

  private static planFullstackWebStructure(category: CanonicalProjectType, stack: TechStackBlueprint): FileStructurePlan {
    const rootDirectories: PlannedDirectory[] = [
      { path: 'src/components', purpose: 'Reusable frontend views, modals, and data visualization widgets' },
      { path: 'src/context', purpose: 'Application state management providers and custom hooks' },
      { path: 'src/types', purpose: 'Domain contracts, API transfer objects, and enum definitions' },
      { path: 'server', purpose: 'Express REST API routes, controllers, and services' },
      { path: 'server/db', purpose: 'Database manager, atomic transaction engine, and schema migrations' },
      { path: 'tests', purpose: 'Automated unit, integration, and security test suites' }
    ];

    const suggestedFiles: PlannedFile[] = [
      { path: 'src/types/index.ts', responsibility: 'Domain entity models and API request/response schemas', role: 'software_architect', priority: 1 },
      { path: 'src/App.tsx', responsibility: 'Application root layout, navigation bar, and view router', role: 'frontend_developer', priority: 1 },
      { path: 'server.ts', responsibility: 'Express server entry point, API middleware, and Vite integration', role: 'software_architect', priority: 1 },
      { path: 'server/store.ts', responsibility: 'Persistent database storage abstraction with in-memory caches', role: 'backend_developer', priority: 2 },
      { path: 'tests/fullstack.test.ts', responsibility: 'Automated tests verifying end-to-end API and state behavior', role: 'qa_testing_specialist', priority: 3 }
    ];

    return {
      rootDirectories,
      suggestedFiles,
      ecosystemConventions: [
        'Strict TypeScript across all files with zero implicit any',
        'Separation of concerns between client presentation and server storage',
        'Defensive input validation on all API endpoints'
      ]
    };
  }
}
