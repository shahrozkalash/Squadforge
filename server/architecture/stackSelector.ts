import { 
  RequirementsAnalysis, 
  TechStackBlueprint, 
  StackSelectionResult, 
  CanonicalProjectType, 
  TargetPlatform,
  TechStackConfig
} from '../types.js';
import { TechnologyStackRegistry } from './techRegistry.js';

export class IntelligentStackSelector {
  /**
   * Evaluates requirements and selects recommended and alternative technology stacks.
   * If existingStack is passed and migration is not requested, preserves established stack.
   */
  static selectStack(
    analysis: RequirementsAnalysis, 
    existingStack?: TechStackConfig, 
    forceMigration: boolean = false
  ): StackSelectionResult {
    const { applicationCategory, targetPlatforms, originalPrompt } = analysis;

    // Check if existing project has an established stack that should be preserved
    if (existingStack && !forceMigration && !this.promptExplicitlyRequestsMigration(originalPrompt)) {
      return this.preserveEstablishedStack(existingStack, analysis);
    }

    // Platform-specific and Category-specific stack selection
    switch (applicationCategory) {
      case 'windows_application':
        return this.selectWindowsStack(analysis);

      case 'android_application':
        return this.selectAndroidStack(analysis);

      case 'cross_platform_mobile':
        return this.selectCrossPlatformMobileStack(analysis);

      case 'cross_platform_desktop':
      case 'desktop_application':
        return this.selectDesktopStack(analysis);

      case 'cli_tool':
      case 'automation_tool':
      case 'developer_tool':
        return this.selectCliToolStack(analysis);

      case 'data_application':
        return this.selectDataStack(analysis);

      case '3d_application':
      case 'engineering_application':
      case 'game_application':
        return this.select3DAndEngineeringStack(analysis);

      case 'creative_application':
      case 'multimedia_application':
        return this.selectMultimediaStack(analysis);

      case 'api_service':
      case 'backend_service':
        return this.selectBackendStack(analysis);

      case 'landing_page':
      case 'portfolio':
      case 'blog':
        return this.selectContentWebStack(analysis);

      case 'ecommerce':
      case 'saas':
      case 'web_application':
      case 'fullstack':
      default:
        return this.selectFullstackWebStack(analysis);
    }
  }

  private static promptExplicitlyRequestsMigration(prompt: string): boolean {
    return /\b(migrate stack|switch framework|rewrite in|change technology|convert to|upgrade to)\b/i.test(prompt);
  }

  private static preserveEstablishedStack(
    existing: TechStackConfig, 
    analysis: RequirementsAnalysis
  ): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: `Preserved Existing Stack (${existing.frontend || 'Default'})`,
      frontend: existing.frontend,
      backend: existing.backend,
      database: existing.database,
      testing: existing.testing,
      primaryLanguage: 'TypeScript / JavaScript'
    };

    const alternative: TechStackBlueprint = {
      name: 'Modernized Next.js Full-Stack Upgrade',
      frontend: 'Next.js 15 (React 19) + Tailwind CSS',
      backend: 'Next.js Server Actions + Node.js Route Handlers',
      database: 'PostgreSQL + Drizzle ORM',
      testing: 'Vitest + Playwright',
      primaryLanguage: 'TypeScript'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Preserved previously established technology stack to prevent breaking existing code, dependencies, and configuration. Stack migration was not explicitly requested.',
      compatibilityWarnings: [],
      knownLimitations: ['Preserves current architecture decisions; manual refactoring required to adopt new frameworks.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm'],
      runtimeRequirements: ['Node.js Runtime'],
      buildAndTestingRequirements: ['npm test', 'npm run build'],
      isPreservedStack: true
    };
  }

  private static selectWindowsStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const isPhotoOrMedia = /\b(photo|image|media|video|cad|gpu)\b/i.test(analysis.originalPrompt);

    const recommended: TechStackBlueprint = {
      name: '.NET 8 / 9 WPF (Windows Presentation Foundation)',
      desktopFramework: '.NET 8 Desktop Runtime + WPF',
      uiFramework: 'XAML + ModernWpf / FluentWPF UI',
      primaryLanguage: 'C#',
      runtime: '.NET 8 Windows Desktop Runtime',
      testing: 'xUnit + FluentAssertions',
      buildTool: 'dotnet build / MSBuild',
      packageManager: 'NuGet'
    };

    const alternative: TechStackBlueprint = {
      name: 'Tauri 2.0 (Windows Native WebView2)',
      desktopFramework: 'Tauri 2.0 (Rust Backend + Native WebView2)',
      uiFramework: isPhotoOrMedia ? 'WebGL/Canvas + React/TypeScript' : 'React 19 + TypeScript',
      primaryLanguage: 'Rust + TypeScript',
      runtime: 'Windows 10/11 with WebView2 Runtime',
      testing: 'cargo test + Vitest',
      buildTool: 'cargo tauri build',
      packageManager: 'cargo + npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'WPF provides first-class native Windows OS integration, hardware-accelerated Direct3D rendering pipeline, native file system dialogues, and deep Win32 API support.',
      compatibilityWarnings: ['Target binaries are Windows-only and cannot execute natively on Linux or macOS hosts without Wine/Proton.'],
      knownLimitations: ['Requires .NET Desktop Runtime and Windows build tooling.'],
      requiredDevelopmentTools: ['.NET SDK 8.0+', 'Visual Studio Build Tools / MSBuild', 'NuGet'],
      runtimeRequirements: ['Windows 10 Version 1809+ or Windows 11'],
      buildAndTestingRequirements: ['dotnet test', 'dotnet publish -c Release -r win-x64 --self-contained']
    };
  }

  private static selectAndroidStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'Native Android (Kotlin + Jetpack Compose)',
      mobileFramework: 'Jetpack Compose Material 3',
      primaryLanguage: 'Kotlin',
      runtime: 'Android OS (API 24+ Android 7.0+)',
      database: 'Room Persistence Library (SQLite)',
      testing: 'JUnit 5 + Compose UI Test + MockK',
      buildTool: 'Gradle (Kotlin DSL)',
      packageManager: 'Gradle / Maven Central'
    };

    const alternative: TechStackBlueprint = {
      name: 'React Native + Expo SDK 52',
      mobileFramework: 'React Native (New Architecture / Fabric)',
      uiFramework: 'React Native Paper / NativeWind',
      primaryLanguage: 'TypeScript',
      runtime: 'Hermes JavaScript Engine on Android',
      database: 'WatermelonDB / expo-sqlite',
      testing: 'Jest + React Native Testing Library',
      buildTool: 'Expo CLI / EAS Build',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Native Kotlin with Jetpack Compose delivers optimal performance, zero JS-bridge overhead, immediate access to latest Android SDK features, and idiomatic lifecycle safety.',
      compatibilityWarnings: ['Requires Android SDK and JDK installed to produce compiled APK/AAB binaries.'],
      knownLimitations: ['Native Kotlin application cannot be deployed to iOS without rewrite or Kotlin Multiplatform abstraction.'],
      requiredDevelopmentTools: ['JDK 17+', 'Android SDK (API 34+)', 'Gradle 8.4+'],
      runtimeRequirements: ['Android Device or Android Emulator (API 24+)'],
      buildAndTestingRequirements: ['./gradlew test', './gradlew assembleRelease']
    };
  }

  private static selectCrossPlatformMobileStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'React Native + Expo SDK 52',
      mobileFramework: 'React Native + Expo Router',
      uiFramework: 'NativeWind (Tailwind CSS for Mobile)',
      primaryLanguage: 'TypeScript',
      runtime: 'Hermes Engine (iOS & Android)',
      database: 'expo-sqlite / AsyncStorage',
      testing: 'Jest + React Native Testing Library',
      buildTool: 'Expo EAS / Metro Bundler',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Flutter (Dart)',
      mobileFramework: 'Flutter Material 3 / Cupertino',
      primaryLanguage: 'Dart',
      runtime: 'Flutter Engine (Skia / Impeller)',
      database: 'Isar / sqflite',
      testing: 'flutter_test',
      buildTool: 'flutter CLI',
      packageManager: 'pub'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'React Native with Expo allows code reuse across both iOS and Android with modern file-based routing and native performance via the Hermes JavaScript engine.',
      compatibilityWarnings: ['Building iOS binaries requires an Apple macOS host with Xcode; Android builds require Android SDK.'],
      knownLimitations: ['Custom native C++ modules require prebuilding and continuous integration dev clients.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'Expo CLI', 'Android Studio / Xcode'],
      runtimeRequirements: ['iOS 15.1+ or Android 7.0+'],
      buildAndTestingRequirements: ['npm test', 'npx expo export']
    };
  }

  private static selectDesktopStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const isPerformanceHeavy = /\b(3d|video|audio|low latency|system|heavy)\b/i.test(analysis.originalPrompt);

    if (isPerformanceHeavy) {
      const recommended: TechStackBlueprint = {
        name: 'Tauri 2.0 (Rust + Web Frontend)',
        desktopFramework: 'Tauri 2.0 Native Shell',
        uiFramework: 'React 19 + TypeScript + Tailwind CSS',
        primaryLanguage: 'Rust (Backend) + TypeScript (UI)',
        runtime: 'OS Native WebView (WebView2 / WebKitGTK / WKWebView)',
        database: 'Embedded SQLite (rusqlite)',
        testing: 'cargo test + Vitest',
        buildTool: 'cargo tauri build',
        packageManager: 'cargo + npm'
      };

      const alternative: TechStackBlueprint = {
        name: 'Qt 6 (C++ / QML)',
        desktopFramework: 'Qt 6 Widgets / QML',
        primaryLanguage: 'Modern C++20',
        runtime: 'Qt 6 Runtime Libraries',
        database: 'QSqlDatabase (SQLite)',
        testing: 'GoogleTest + QTest',
        buildTool: 'CMake + Ninja',
        packageManager: 'vcpkg'
      };

      return {
        recommendedStack: recommended,
        alternativeStack: alternative,
        explanation: 'Tauri provides native memory safety, ~15MB distribution binaries, and zero-overhead native Rust backend execution paired with a modern React UI layer.',
        compatibilityWarnings: ['Requires Rust toolchain and platform C++ build tools on host machine.'],
        knownLimitations: ['Inter-process communication between Rust and WebView has slight serialization overhead for multi-megabyte binary streams.'],
        requiredDevelopmentTools: ['Rust (rustc/cargo >= 1.77)', 'Node.js >= 20.x', 'Platform C/C++ compiler'],
        runtimeRequirements: ['Windows (WebView2), macOS (WKWebView), or Linux (WebKitGTK)'],
        buildAndTestingRequirements: ['cargo test', 'npm run tauri build']
      };
    }

    const recommended: TechStackBlueprint = {
      name: 'Electron + React + TypeScript',
      desktopFramework: 'Electron (Main & Preload Context Isolation)',
      uiFramework: 'React 19 + Tailwind CSS + Lucide Icons',
      primaryLanguage: 'TypeScript',
      runtime: 'Bundled Chromium + Node.js 22 Runtime',
      database: 'better-sqlite3 / embedded JSON store',
      testing: 'Vitest + Playwright',
      buildTool: 'electron-builder + Vite',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Tauri 2.0 + React',
      desktopFramework: 'Tauri 2.0 Native Shell',
      uiFramework: 'React 19 + TypeScript + Tailwind CSS',
      primaryLanguage: 'Rust + TypeScript',
      runtime: 'OS Native WebView',
      database: 'Embedded SQLite',
      testing: 'cargo test + Vitest',
      buildTool: 'cargo tauri build',
      packageManager: 'cargo + npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Electron ensures pixel-perfect UI parity across Windows, macOS, and Linux with full access to Node.js backend capabilities and extensive desktop ecosystem libraries.',
      compatibilityWarnings: ['Binaries average 80-120MB and require higher base RAM (~100-200MB) due to bundled Chromium engine.'],
      knownLimitations: ['Context isolation and secure IPC bridges must be strictly enforced to prevent remote code execution vulnerabilities.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'electron-builder'],
      runtimeRequirements: ['Windows 10/11, macOS 11+, or modern Linux distribution'],
      buildAndTestingRequirements: ['npm test', 'npm run build:electron']
    };
  }

  private static selectCliToolStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const isPythonDominant = /\b(python|pandas|scikit|ai|scraping|script)\b/i.test(analysis.originalPrompt);

    if (isPythonDominant) {
      const recommended: TechStackBlueprint = {
        name: 'Python 3.12 CLI (Click / Typer + Rich)',
        primaryLanguage: 'Python',
        runtime: 'Python >= 3.10',
        testing: 'pytest',
        buildTool: 'hatch / flit / PyInstaller',
        packageManager: 'uv / pip'
      };

      const alternative: TechStackBlueprint = {
        name: 'Rust CLI (Clap + Tokio)',
        primaryLanguage: 'Rust',
        runtime: 'Standalone Compiled Native Binary',
        testing: 'cargo test',
        buildTool: 'cargo build --release',
        packageManager: 'cargo'
      };

      return {
        recommendedStack: recommended,
        alternativeStack: alternative,
        explanation: 'Python with Typer and Rich provides rapid development, built-in data science library interoperability, beautiful terminal output, and type-annotated CLI parsing.',
        compatibilityWarnings: ['Users must have Python installed or distribution must package a standalone executable via PyInstaller.'],
        knownLimitations: ['Interpreted startup overhead is higher than Go or Rust compiled binaries.'],
        requiredDevelopmentTools: ['Python >= 3.10', 'uv / pip'],
        runtimeRequirements: ['Python 3.10+'],
        buildAndTestingRequirements: ['pytest tests/']
      };
    }

    const recommended: TechStackBlueprint = {
      name: 'TypeScript / Node.js CLI (Commander + Chalk)',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'Node.js native test runner (node:test)',
      buildTool: 'esbuild / tsx',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Go (Golang) Single Binary CLI (Cobra)',
      primaryLanguage: 'Go',
      runtime: 'Static Executable (Zero External Dependencies)',
      testing: 'go test',
      buildTool: 'go build -ldflags="-s -w"',
      packageManager: 'go modules'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'TypeScript CLI with Commander delivers strong typing, native Node.js ecosystem access, frictionless npm distribution, and rapid automated testing.',
      compatibilityWarnings: ['Requires Node.js runtime installed on client machine unless packaged with standalone binary generator.'],
      knownLimitations: ['Single-threaded event loop requires child process spawning for CPU-intensive parallel worker tasks.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'tsx'],
      runtimeRequirements: ['Node.js >= 20.x'],
      buildAndTestingRequirements: ['npm test']
    };
  }

  private static selectDataStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'Python Data Engine (FastAPI + Polars / DuckDB)',
      backend: 'FastAPI + Uvicorn ASGI Server',
      database: 'DuckDB (Embedded In-Process Analytical SQL) / SQLite',
      primaryLanguage: 'Python',
      runtime: 'Python 3.11 / 3.12',
      testing: 'pytest',
      buildTool: 'uv / pip',
      packageManager: 'uv'
    };

    const alternative: TechStackBlueprint = {
      name: 'Node.js + Apache Arrow / DuckDB-Wasm + Express',
      backend: 'Node.js Express + DuckDB-Node',
      database: 'DuckDB / PostgreSQL',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'node:test',
      buildTool: 'tsx / esbuild',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Python paired with DuckDB and Polars delivers ultra-fast vectorized columnar analytical querying with lower memory overhead than legacy Pandas.',
      compatibilityWarnings: ['Requires Python runtime and C-compiled native libraries.'],
      knownLimitations: ['High-throughput streaming requires careful buffer allocation to prevent out-of-memory crashes on large datasets.'],
      requiredDevelopmentTools: ['Python >= 3.10', 'uv / pip'],
      runtimeRequirements: ['Python 3.10+'],
      buildAndTestingRequirements: ['pytest tests/']
    };
  }

  private static select3DAndEngineeringStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const isDesktopRequested = analysis.targetPlatforms.includes('windows') || analysis.targetPlatforms.includes('linux');

    if (isDesktopRequested && /\b(vulkan|opengl|native|high performance|c\+\+)\b/i.test(analysis.originalPrompt)) {
      const recommended: TechStackBlueprint = {
        name: 'Native 3D Engineering (C++20 + Vulkan / OpenGL + Qt6)',
        desktopFramework: 'Qt6 Core & GUI',
        graphicsApi: 'Vulkan 1.3 / OpenGL 4.6',
        primaryLanguage: 'Modern C++20',
        runtime: 'Hardware GPU Architecture',
        testing: 'GoogleTest',
        buildTool: 'CMake + Ninja',
        packageManager: 'vcpkg'
      };

      const alternative: TechStackBlueprint = {
        name: 'WebGPU / Three.js Desktop Application (Tauri 2.0)',
        desktopFramework: 'Tauri 2.0',
        graphicsApi: 'WebGPU / Three.js',
        primaryLanguage: 'Rust + TypeScript',
        runtime: 'Modern OS GPU Driver',
        testing: 'cargo test + Vitest',
        buildTool: 'cargo tauri build',
        packageManager: 'cargo + npm'
      };

      return {
        recommendedStack: recommended,
        alternativeStack: alternative,
        explanation: 'C++20 with Vulkan provides bare-metal GPU command queue control, zero abstraction latency, and direct compute shader dispatch essential for engineering simulations.',
        compatibilityWarnings: ['Requires dedicated hardware GPU with Vulkan/OpenGL driver support and C++ compilation toolchain.'],
        knownLimitations: ['Manual memory allocation and explicit pipeline state management required.'],
        requiredDevelopmentTools: ['CMake 3.25+', 'Clang/MSVC/GCC', 'Vulkan SDK', 'vcpkg'],
        runtimeRequirements: ['Hardware GPU with Vulkan 1.2+ driver'],
        buildAndTestingRequirements: ['ctest --output-on-failure', 'cmake --build build --config Release']
      };
    }

    const recommended: TechStackBlueprint = {
      name: 'Web 3D Engine (Three.js + React Three Fiber + Vite)',
      frontend: 'React 19 + Three.js + React Three Fiber (@react-three/fiber)',
      graphicsApi: 'WebGL 2.0 / WebGPU',
      primaryLanguage: 'TypeScript',
      runtime: 'Modern Browser GPU Engine',
      testing: 'Vitest + Playwright (Visual Regression)',
      buildTool: 'Vite',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Babylon.js Engineering Canvas',
      frontend: 'Babylon.js 7.0 + TypeScript',
      graphicsApi: 'WebGPU Native Canvas',
      primaryLanguage: 'TypeScript',
      runtime: 'Modern Browser GPU Engine',
      testing: 'Vitest',
      buildTool: 'Vite',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Three.js with React Three Fiber enables declarative 3D scene graphs, cross-platform browser accessibility with zero installation, and smooth 60 FPS interactive rendering.',
      compatibilityWarnings: ['Older client GPUs or mobile devices without hardware acceleration may experience lower frame rates.'],
      knownLimitations: ['Browser memory sandbox limits scene geometry sizes compared to native desktop applications.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'Vite'],
      runtimeRequirements: ['Modern Browser with WebGL 2.0 or WebGPU support'],
      buildAndTestingRequirements: ['npm test', 'npm run build']
    };
  }

  private static selectMultimediaStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'Web Multimedia Suite (HTML5 Canvas / Web Audio API + WebAssembly)',
      frontend: 'React 19 + Konva / Canvas 2D + Web Audio API',
      primaryLanguage: 'TypeScript + WebAssembly',
      runtime: 'Modern Browser Engine',
      testing: 'Vitest',
      buildTool: 'Vite',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Native Python Multimedia Pipeline (PyQt6 + OpenCV + FFmpeg)',
      desktopFramework: 'PyQt6',
      primaryLanguage: 'Python',
      runtime: 'Python 3.11 with FFmpeg binaries',
      testing: 'pytest',
      buildTool: 'PyInstaller',
      packageManager: 'uv / pip'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'HTML5 2D Canvas paired with Web Audio API provides real-time client-side media manipulation with instantaneous feedback and zero external binary dependencies.',
      compatibilityWarnings: ['Heavy video transcoding in-browser requires WebAssembly FFmpeg and SharedArrayBuffer headers.'],
      knownLimitations: ['Client memory ceiling prevents editing ultra-large (8K+) raw uncompressed media.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm'],
      runtimeRequirements: ['Modern Browser runtime'],
      buildAndTestingRequirements: ['npm test', 'npm run build']
    };
  }

  private static selectBackendStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const isPython = /\b(python|django|fastapi)\b/i.test(analysis.originalPrompt);
    const isGo = /\b(go|golang)\b/i.test(analysis.originalPrompt);

    if (isGo) {
      const recommended: TechStackBlueprint = {
        name: 'Go High-Performance Microservice (Chi / Gin + SQLX)',
        backend: 'Go Standard Library / Chi Router',
        database: 'PostgreSQL + pgx connection pool',
        primaryLanguage: 'Go',
        runtime: 'Static Linux ELF Binary (~15MB)',
        testing: 'go test',
        buildTool: 'go build',
        packageManager: 'go modules'
      };

      const alternative: TechStackBlueprint = {
        name: 'Node.js Fastify API Server',
        backend: 'Fastify + TypeScript',
        database: 'PostgreSQL + Drizzle ORM',
        primaryLanguage: 'TypeScript',
        runtime: 'Node.js >= 20.x',
        testing: 'node:test',
        buildTool: 'tsx / esbuild',
        packageManager: 'npm'
      };

      return {
        recommendedStack: recommended,
        alternativeStack: alternative,
        explanation: 'Go provides goroutine concurrency for handling tens of thousands of concurrent network connections with single-digit millisecond latency.',
        compatibilityWarnings: ['Requires Go toolchain to compile binary.'],
        knownLimitations: ['Less dynamic reflection and metaprogramming than interpreted scripting languages.'],
        requiredDevelopmentTools: ['Go 1.22+'],
        runtimeRequirements: ['Linux / Windows / macOS OS'],
        buildAndTestingRequirements: ['go test ./...']
      };
    }

    if (isPython) {
      const recommended: TechStackBlueprint = {
        name: 'Python FastAPI REST Service',
        backend: 'FastAPI + Uvicorn ASGI Server',
        database: 'PostgreSQL + SQLAlchemy 2.0 Async',
        primaryLanguage: 'Python',
        runtime: 'Python 3.11 / 3.12',
        testing: 'pytest + httpx',
        buildTool: 'uv / pip',
        packageManager: 'uv'
      };

      const alternative: TechStackBlueprint = {
        name: 'Node.js Express + TypeScript Server',
        backend: 'Node.js Express + TypeScript',
        database: 'PostgreSQL + Prisma / Drizzle',
        primaryLanguage: 'TypeScript',
        runtime: 'Node.js >= 20.x',
        testing: 'node:test',
        buildTool: 'tsx',
        packageManager: 'npm'
      };

      return {
        recommendedStack: recommended,
        alternativeStack: alternative,
        explanation: 'FastAPI provides automatic OpenAPI documentation generation, async IO request handling, and strict Pydantic data validation.',
        compatibilityWarnings: ['Requires Python runtime installed on host.'],
        knownLimitations: ['CPU-heavy synchronous tasks block async event loop unless dispatched to thread pools.'],
        requiredDevelopmentTools: ['Python >= 3.10', 'uv / pip'],
        runtimeRequirements: ['Python 3.10+'],
        buildAndTestingRequirements: ['pytest tests/']
      };
    }

    // Default Node.js / Express backend
    const recommended: TechStackBlueprint = {
      name: 'Node.js Express + TypeScript REST API Server',
      backend: 'Express 4.21 + TypeScript + Zod Validation',
      database: 'SQLite Persistent Database (Node.js 22 built-in node:sqlite)',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'Node.js native test runner (node:test + assert)',
      buildTool: 'tsx / esbuild',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Fastify High-Throughput API Server',
      backend: 'Fastify + TypeBox Schema Validation',
      database: 'PostgreSQL + Drizzle ORM',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'node:test',
      buildTool: 'tsx',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Node.js with Express and TypeScript provides a proven, flexible API framework with defense-in-depth validation and built-in persistent storage.',
      compatibilityWarnings: [],
      knownLimitations: ['Intensive CPU blocking computations must be offloaded to worker threads.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'tsx'],
      runtimeRequirements: ['Node.js >= 20.x'],
      buildAndTestingRequirements: ['npm test']
    };
  }

  private static selectContentWebStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'React 19 + TypeScript + Tailwind CSS (Zero-Runtime)',
      frontend: 'React 19 + TypeScript + Tailwind CSS',
      backend: 'Node.js Express + Static Preview Generator',
      database: 'Client-Side Local Storage & Markdown Document Store',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x / Browser',
      testing: 'Node.js Native Test Runner (node:test + assert)',
      buildTool: 'Vite',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Astro 4.0 Content Engine',
      frontend: 'Astro Islands + Markdown / MDX',
      backend: 'Static Site Generator with Edge API Handlers',
      primaryLanguage: 'TypeScript',
      runtime: 'Static HTML/CSS with minimal hydration',
      testing: 'Playwright',
      buildTool: 'Astro CLI',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Modern utility-first styling with React 19 component composition delivers instant first contentful paint, SEO compatibility, and responsive design.',
      compatibilityWarnings: [],
      knownLimitations: ['Client-only state without server-side database will reset when local cache is cleared.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'Vite'],
      runtimeRequirements: ['Modern Web Browser'],
      buildAndTestingRequirements: ['npm test', 'npm run build']
    };
  }

  private static selectFullstackWebStack(analysis: RequirementsAnalysis): StackSelectionResult {
    const recommended: TechStackBlueprint = {
      name: 'Full-Stack React 19 + Node.js Express + TypeScript',
      frontend: 'React 19 + TypeScript + Tailwind CSS + Lucide Icons',
      backend: 'Node.js Express + TypeScript Server API',
      database: 'SQLite Persistent Database (node:sqlite) + In-Memory Caches',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'Node.js Native Test Runner (node:test + assert)',
      buildTool: 'Vite + tsx',
      packageManager: 'npm'
    };

    const alternative: TechStackBlueprint = {
      name: 'Next.js 15 Full-Stack App Router',
      frontend: 'Next.js 15 (React 19) + Tailwind CSS',
      backend: 'Next.js Server Actions + Route Handlers',
      database: 'PostgreSQL + Drizzle ORM',
      primaryLanguage: 'TypeScript',
      runtime: 'Node.js >= 20.x',
      testing: 'Vitest + Playwright',
      buildTool: 'Next.js Turbopack',
      packageManager: 'npm'
    };

    return {
      recommendedStack: recommended,
      alternativeStack: alternative,
      explanation: 'Proven, decoupled SPA + Express architecture allowing independent scaling, hot-reloading dev server with middleware mode, and comprehensive automated test runner.',
      compatibilityWarnings: [],
      knownLimitations: ['Multi-process coordination requires explicit concurrency controls during parallel development.'],
      requiredDevelopmentTools: ['Node.js >= 20.x', 'npm', 'Vite', 'tsx'],
      runtimeRequirements: ['Node.js >= 20.x', 'Modern Web Browser'],
      buildAndTestingRequirements: ['npm test', 'npm run build']
    };
  }
}
