import { 
  TechRegistryEntry, 
  CanonicalProjectType, 
  TargetPlatform, 
  TechCategory,
  CompatibilityStatus 
} from '../types.js';

export class TechnologyStackRegistry {
  private static entries: Map<string, TechRegistryEntry> = new Map();

  static {
    this.registerDefaults();
  }

  static register(entry: TechRegistryEntry): void {
    this.entries.set(entry.id, entry);
  }

  static get(id: string): TechRegistryEntry | undefined {
    return this.entries.get(id);
  }

  static getAll(): TechRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  static findByCategory(category: TechCategory): TechRegistryEntry[] {
    return this.getAll().filter(e => e.category === category);
  }

  static getByCategory(category: TechCategory): TechRegistryEntry[] {
    return this.findByCategory(category);
  }

  static findByPlatform(platform: TargetPlatform): TechRegistryEntry[] {
    return this.getAll().filter(e => e.supportedPlatforms.includes(platform) || e.supportedPlatforms.includes('cross_platform'));
  }

  static getByPlatform(platform: TargetPlatform): TechRegistryEntry[] {
    return this.findByPlatform(platform);
  }

  static findByProjectType(projectType: CanonicalProjectType): TechRegistryEntry[] {
    return this.getAll().filter(e => e.projectTypes.includes(projectType));
  }

  static getByProjectType(projectType: CanonicalProjectType): TechRegistryEntry[] {
    return this.findByProjectType(projectType);
  }

  private static registerDefaults(): void {
    const list: TechRegistryEntry[] = [
      // ==========================================
      // WEB TECHNOLOGIES
      // ==========================================
      {
        id: 'react',
        displayName: 'React 19',
        category: 'frontend',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['landing_page', 'portfolio', 'saas', 'ecommerce', 'web_application', 'fullstack', 'custom'],
        runtimeRequirements: ['Node.js >= 20.x or modern browser runtime'],
        buildTooling: ['Vite', 'esbuild'],
        packageManager: 'npm',
        testingEcosystem: ['Vitest', '@testing-library/react', 'Playwright'],
        deploymentOptions: ['Static Cloud CDN', 'Vercel', 'Docker Nginx'],
        knownLimitations: ['Requires hydration or client-side JS runtime; not native desktop without wrapper'],
        documentationReference: 'https://react.dev',
        compatibilityStatus: 'verified'
      },
      {
        id: 'nextjs',
        displayName: 'Next.js App Router',
        category: 'fullstack',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['saas', 'ecommerce', 'web_application', 'fullstack', 'blog', 'landing_page'],
        runtimeRequirements: ['Node.js >= 20.x'],
        buildTooling: ['Turbopack', 'Next CLI'],
        packageManager: 'npm',
        testingEcosystem: ['Vitest', 'Playwright'],
        deploymentOptions: ['Node.js standalone server', 'Vercel', 'Docker container'],
        knownLimitations: ['Requires server-side Node.js runtime or standalone output configuration'],
        documentationReference: 'https://nextjs.org/docs',
        compatibilityStatus: 'verified'
      },
      {
        id: 'vue',
        displayName: 'Vue 3 (Composition API)',
        category: 'frontend',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['web_application', 'saas', 'landing_page', 'portfolio', 'custom'],
        runtimeRequirements: ['Modern browser runtime', 'Node.js for build'],
        buildTooling: ['Vite'],
        packageManager: 'npm',
        testingEcosystem: ['Vitest', '@vue/test-utils'],
        deploymentOptions: ['Static CDN', 'Docker Nginx'],
        knownLimitations: ['Ecosystem divergence between Options API and Composition API'],
        documentationReference: 'https://vuejs.org',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'svelte',
        displayName: 'Svelte 5 / SvelteKit',
        category: 'frontend',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['web_application', 'landing_page', 'portfolio', 'saas', 'custom'],
        runtimeRequirements: ['Modern browser runtime', 'Node.js for build'],
        buildTooling: ['Vite'],
        packageManager: 'npm',
        testingEcosystem: ['Vitest', '@testing-library/svelte'],
        deploymentOptions: ['Static CDN', 'Node.js adapter', 'Docker'],
        knownLimitations: ['Compile-step essential; smaller third-party UI ecosystem than React'],
        documentationReference: 'https://svelte.dev',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'angular',
        displayName: 'Angular (Signals)',
        category: 'frontend',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript'],
        projectTypes: ['web_application', 'saas', 'custom'],
        runtimeRequirements: ['Modern browser runtime', 'Node.js for build'],
        buildTooling: ['Angular CLI', 'esbuild'],
        packageManager: 'npm',
        testingEcosystem: ['Jasmine', 'Karma', 'Jest'],
        deploymentOptions: ['Static Web Server', 'Docker Nginx'],
        knownLimitations: ['Steep learning curve, higher boilerplate than micro-frameworks'],
        documentationReference: 'https://angular.dev',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'nodejs_express',
        displayName: 'Node.js + Express',
        category: 'backend',
        supportedPlatforms: ['web', 'cloud', 'linux'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['api_service', 'backend_service', 'fullstack', 'saas', 'ecommerce', 'custom'],
        runtimeRequirements: ['Node.js >= 20.x'],
        buildTooling: ['tsx', 'tsc', 'esbuild'],
        packageManager: 'npm',
        testingEcosystem: ['Node.js native test runner (node:test)', 'Jest', 'Supertest'],
        deploymentOptions: ['Docker container', 'Cloud Run', 'AWS ECS', 'VPS'],
        knownLimitations: ['Single-threaded event loop requires clustering or worker threads for heavy CPU tasks'],
        documentationReference: 'https://expressjs.com',
        compatibilityStatus: 'verified'
      },
      {
        id: 'fastify',
        displayName: 'Fastify',
        category: 'backend',
        supportedPlatforms: ['web', 'cloud', 'linux'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['api_service', 'backend_service', 'saas', 'fullstack'],
        runtimeRequirements: ['Node.js >= 20.x'],
        buildTooling: ['tsx', 'tsc'],
        packageManager: 'npm',
        testingEcosystem: ['node:test', 'Tap', 'Vitest'],
        deploymentOptions: ['Docker container', 'Cloud Run', 'Kubernetes'],
        knownLimitations: ['Strict schema-based lifecycle requires careful plugin ordering'],
        documentationReference: 'https://fastify.dev',
        compatibilityStatus: 'verified'
      },
      {
        id: 'python_fastapi',
        displayName: 'Python FastAPI',
        category: 'backend',
        supportedPlatforms: ['web', 'cloud', 'linux', 'windows'],
        programmingLanguages: ['python'],
        projectTypes: ['api_service', 'backend_service', 'data_application', 'automation_tool'],
        runtimeRequirements: ['Python >= 3.10', 'Uvicorn ASGI'],
        buildTooling: ['uv', 'pip', 'poetry'],
        packageManager: 'uv / pip',
        testingEcosystem: ['pytest', 'httpx'],
        deploymentOptions: ['Docker container', 'Cloud Run', 'AWS Lambda'],
        knownLimitations: ['Requires Python runtime environment installed on host or container'],
        documentationReference: 'https://fastapi.tiangolo.com',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'django',
        displayName: 'Python Django',
        category: 'fullstack',
        supportedPlatforms: ['web', 'cloud', 'linux'],
        programmingLanguages: ['python'],
        projectTypes: ['fullstack', 'saas', 'ecommerce', 'web_application', 'data_application'],
        runtimeRequirements: ['Python >= 3.10', 'WSGI/ASGI server'],
        buildTooling: ['pip', 'poetry'],
        packageManager: 'pip',
        testingEcosystem: ['pytest-django', 'unittest'],
        deploymentOptions: ['Docker container', 'VPS with Gunicorn', 'AWS Elastic Beanstalk'],
        knownLimitations: ['Monolithic architecture; heavier overhead than micro-frameworks; requires Python'],
        documentationReference: 'https://djangoproject.com',
        compatibilityStatus: 'external_runtime_required'
      },

      // ==========================================
      // DESKTOP TECHNOLOGIES
      // ==========================================
      {
        id: 'electron',
        displayName: 'Electron',
        category: 'desktop',
        supportedPlatforms: ['cross_platform', 'windows', 'macos', 'linux'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['desktop_application', 'cross_platform_desktop', 'creative_application', 'multimedia_application', 'developer_tool'],
        runtimeRequirements: ['Node.js + Chromium bundled engine'],
        buildTooling: ['electron-builder', 'electron-forge'],
        packageManager: 'npm',
        testingEcosystem: ['Playwright Test', 'Spectron'],
        deploymentOptions: ['NSIS (.exe)', 'DMG / PKG', 'AppImage / Snap'],
        knownLimitations: ['Larger binary footprint (~80-120MB) and higher base memory usage due to bundled Chromium'],
        documentationReference: 'https://electronjs.org',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'tauri',
        displayName: 'Tauri 2.0',
        category: 'desktop',
        supportedPlatforms: ['cross_platform', 'windows', 'macos', 'linux', 'android', 'ios'],
        programmingLanguages: ['rust', 'typescript', 'javascript'],
        projectTypes: ['desktop_application', 'cross_platform_desktop', 'developer_tool', 'creative_application'],
        compatibilityRequirements: ['Rust toolchain >= 1.77', 'OS WebView (WebView2 / WebKitGTK)'],
        runtimeRequirements: ['OS-native WebView'],
        buildTooling: ['cargo', 'tauri-cli'],
        packageManager: 'cargo + npm',
        testingEcosystem: ['cargo test', 'Playwright'],
        deploymentOptions: ['MSI / Windows Installer', 'AppImage', 'DMG'],
        knownLimitations: ['Requires Rust compiler and native platform build tools to compile binaries'],
        documentationReference: 'https://tauri.app',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'dotnet_wpf',
        displayName: '.NET 8 / 9 WPF (Windows Presentation Foundation)',
        category: 'desktop',
        supportedPlatforms: ['windows'],
        programmingLanguages: ['csharp'],
        projectTypes: ['windows_application', 'desktop_application', 'engineering_application', 'multimedia_application'],
        compatibilityRequirements: ['Windows 10/11 x64/arm64', '.NET Desktop Runtime'],
        runtimeRequirements: ['.NET 8.0+ Windows Desktop Runtime'],
        buildTooling: ['dotnet CLI', 'MSBuild', 'Visual Studio'],
        packageManager: 'NuGet',
        testingEcosystem: ['xUnit', 'NUnit', 'MSTest'],
        deploymentOptions: ['MSI installer', 'ClickOnce', 'Single-file self-contained .exe'],
        knownLimitations: ['Strictly Windows-only; cannot run natively on Linux or macOS'],
        documentationReference: 'https://learn.microsoft.com/dotnet/desktop/wpf',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'qt_framework',
        displayName: 'Qt 6 (C++ / QML / PyQt)',
        category: 'desktop',
        supportedPlatforms: ['cross_platform', 'windows', 'macos', 'linux', 'embedded'],
        programmingLanguages: ['cpp', 'python'],
        projectTypes: ['desktop_application', 'cross_platform_desktop', 'engineering_application', '3d_application', 'multimedia_application'],
        compatibilityRequirements: ['CMake >= 3.22', 'C++17/20 compiler or Python >= 3.10'],
        runtimeRequirements: ['Qt6 runtime libraries or PySide6'],
        buildTooling: ['CMake', 'qmake', 'Ninja'],
        packageManager: 'vcpkg / Conan / pip',
        testingEcosystem: ['QTest', 'GoogleTest', 'pytest-qt'],
        deploymentOptions: ['windeployqt standalone installer', 'AppImage', 'Mac Deploy'],
        knownLimitations: ['Licensing considerations (LGPLv3/Commercial); requires C++ compilation toolchain'],
        documentationReference: 'https://qt.io',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'python_desktop',
        displayName: 'Python Desktop (PyQt6 / Tkinter / CustomTkinter)',
        category: 'desktop',
        supportedPlatforms: ['cross_platform', 'windows', 'macos', 'linux'],
        programmingLanguages: ['python'],
        projectTypes: ['desktop_application', 'developer_tool', 'automation_tool', 'data_application'],
        runtimeRequirements: ['Python >= 3.10'],
        buildTooling: ['PyInstaller', 'Nuitka'],
        packageManager: 'pip / uv',
        testingEcosystem: ['pytest'],
        deploymentOptions: ['Single-file executable via PyInstaller'],
        knownLimitations: ['PyInstaller binaries can be flagged by antivirus; slower GUI performance than native C# or C++'],
        documentationReference: 'https://riverbankcomputing.com/software/pyqt',
        compatibilityStatus: 'external_runtime_required'
      },

      // ==========================================
      // MOBILE TECHNOLOGIES
      // ==========================================
      {
        id: 'react_native',
        displayName: 'React Native + Expo',
        category: 'mobile',
        supportedPlatforms: ['cross_platform', 'android', 'ios'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['cross_platform_mobile', 'android_application', 'custom'],
        runtimeRequirements: ['Node.js for bundler', 'Android SDK / Xcode for native compilation'],
        buildTooling: ['Expo CLI', 'Metro bundler', 'Gradle'],
        packageManager: 'npm',
        testingEcosystem: ['Jest', 'React Native Testing Library', 'Detox'],
        deploymentOptions: ['Google Play Store (.aab)', 'Apple App Store (.ipa)', 'Expo EAS'],
        knownLimitations: ['Native modules require compilation tools; native Android/iOS SDK required for full builds'],
        documentationReference: 'https://reactnative.dev',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'flutter',
        displayName: 'Flutter',
        category: 'mobile',
        supportedPlatforms: ['cross_platform', 'android', 'ios', 'windows', 'macos', 'linux'],
        programmingLanguages: ['dart'],
        projectTypes: ['cross_platform_mobile', 'android_application', 'cross_platform_desktop'],
        runtimeRequirements: ['Flutter SDK', 'Dart runtime'],
        buildTooling: ['flutter CLI', 'Gradle'],
        packageManager: 'pub',
        testingEcosystem: ['flutter_test', 'integration_test'],
        deploymentOptions: ['Google Play (.aab)', 'App Store (.ipa)', 'Desktop Executables'],
        knownLimitations: ['Requires Dart language toolchain and Flutter SDK; custom UI rendering canvas'],
        documentationReference: 'https://flutter.dev',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'native_android_kotlin',
        displayName: 'Native Android (Kotlin + Jetpack Compose)',
        category: 'mobile',
        supportedPlatforms: ['android'],
        programmingLanguages: ['kotlin', 'java'],
        projectTypes: ['android_application', 'custom'],
        compatibilityRequirements: ['Android SDK >= 34', 'JDK >= 17', 'Gradle >= 8.0'],
        runtimeRequirements: ['Android OS >= 7.0 (API 24+)'],
        buildTooling: ['Gradle', 'Android Studio CLI'],
        packageManager: 'Gradle / Maven',
        testingEcosystem: ['JUnit 5', 'Compose UI Test', 'Espresso'],
        deploymentOptions: ['Android App Bundle (.aab)', 'APK'],
        knownLimitations: ['Platform-locked to Android; requires complete Android SDK and JDK to produce binaries'],
        documentationReference: 'https://developer.android.com/compose',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'native_ios_swift',
        displayName: 'Native iOS (Swift + SwiftUI)',
        category: 'mobile',
        supportedPlatforms: ['ios'],
        programmingLanguages: ['swift'],
        projectTypes: ['cross_platform_mobile', 'custom'],
        compatibilityRequirements: ['macOS host system', 'Xcode >= 15'],
        runtimeRequirements: ['iOS >= 16.0'],
        buildTooling: ['xcodebuild', 'Swift Package Manager'],
        packageManager: 'SwiftPM',
        testingEcosystem: ['XCTest', 'ViewInspector'],
        deploymentOptions: ['Apple App Store', 'TestFlight'],
        knownLimitations: ['Strictly requires macOS hardware and Xcode compiler for build and execution'],
        documentationReference: 'https://developer.apple.com/xcode/swiftui',
        compatibilityStatus: 'external_runtime_required'
      },

      // ==========================================
      // SYSTEMS & TOOLS
      // ==========================================
      {
        id: 'python_systems',
        displayName: 'Python Systems & CLI',
        category: 'systems',
        supportedPlatforms: ['cli', 'linux', 'windows', 'macos', 'cloud'],
        programmingLanguages: ['python'],
        projectTypes: ['cli_tool', 'automation_tool', 'developer_tool', 'data_application'],
        runtimeRequirements: ['Python >= 3.10'],
        buildTooling: ['uv', 'pip', 'wheel', 'hatch'],
        packageManager: 'pip / uv',
        testingEcosystem: ['pytest', 'coverage'],
        deploymentOptions: ['PyPI distribution', 'Standalone binary via PyInstaller or Shiv'],
        knownLimitations: ['Requires local Python interpreter for uncompiled execution'],
        documentationReference: 'https://python.org',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'typescript_cli',
        displayName: 'TypeScript / Node.js CLI & Systems',
        category: 'systems',
        supportedPlatforms: ['cli', 'linux', 'windows', 'macos', 'cross_platform'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['cli_tool', 'developer_tool', 'automation_tool'],
        runtimeRequirements: ['Node.js >= 20.x'],
        buildTooling: ['tsx', 'tsc', 'pkg', 'esbuild'],
        packageManager: 'npm',
        testingEcosystem: ['node:test', 'Vitest'],
        deploymentOptions: ['npm global package', 'Single-file compiled binary via pkg'],
        knownLimitations: ['Requires Node runtime unless bundled with standalone runtime binary'],
        documentationReference: 'https://nodejs.org/api/cli.html',
        compatibilityStatus: 'verified'
      },
      {
        id: 'rust_systems',
        displayName: 'Rust Systems & Tooling',
        category: 'systems',
        supportedPlatforms: ['cross_platform', 'linux', 'windows', 'macos', 'cli', 'embedded'],
        programmingLanguages: ['rust'],
        projectTypes: ['cli_tool', 'developer_tool', 'engineering_application', 'custom'],
        compatibilityRequirements: ['Rustc >= 1.77', 'Cargo'],
        runtimeRequirements: ['None (compiles to static native machine code)'],
        buildTooling: ['cargo', 'rustc'],
        packageManager: 'cargo (crates.io)',
        testingEcosystem: ['cargo test', 'criterion (benchmarking)'],
        deploymentOptions: ['Static zero-dependency native executable (.exe / ELF / Mach-O)'],
        knownLimitations: ['Steep borrow checker learning curve; compilation times longer than interpreted languages'],
        documentationReference: 'https://rust-lang.org',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'golang_systems',
        displayName: 'Go (Golang) Microservices & CLI',
        category: 'systems',
        supportedPlatforms: ['cross_platform', 'linux', 'windows', 'macos', 'cloud', 'cli'],
        programmingLanguages: ['go'],
        projectTypes: ['cli_tool', 'api_service', 'backend_service', 'automation_tool', 'developer_tool'],
        compatibilityRequirements: ['Go >= 1.22'],
        runtimeRequirements: ['None (static compiled single binary)'],
        buildTooling: ['go build'],
        packageManager: 'go modules',
        testingEcosystem: ['go test', 'testify'],
        deploymentOptions: ['Scratch Docker container (single binary ~15MB)', 'Direct binary distribution'],
        knownLimitations: ['Garbage collection latency may restrict hard real-time systems programming'],
        documentationReference: 'https://go.dev',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'cpp_systems',
        displayName: 'Modern C++ (C++20)',
        category: 'systems',
        supportedPlatforms: ['cross_platform', 'windows', 'linux', 'macos'],
        programmingLanguages: ['cpp'],
        projectTypes: ['engineering_application', '3d_application', 'multimedia_application', 'game_application', 'developer_tool'],
        compatibilityRequirements: ['Clang 16+, GCC 13+, or MSVC 2022', 'CMake >= 3.25'],
        runtimeRequirements: ['Native OS architecture'],
        buildTooling: ['CMake', 'Ninja', 'MSBuild'],
        packageManager: 'vcpkg / Conan',
        testingEcosystem: ['GoogleTest', 'Catch2'],
        deploymentOptions: ['Native compiled binary with dynamically linked or static runtime'],
        knownLimitations: ['Manual memory safety risks; complex cross-compilation toolchain setup'],
        documentationReference: 'https://en.cppreference.com',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'csharp_systems',
        displayName: 'C# / .NET Core',
        category: 'systems',
        supportedPlatforms: ['cross_platform', 'windows', 'linux', 'macos', 'cloud'],
        programmingLanguages: ['csharp'],
        projectTypes: ['api_service', 'backend_service', 'developer_tool', 'windows_application'],
        runtimeRequirements: ['.NET 8.0+ runtime'],
        buildTooling: ['dotnet CLI'],
        packageManager: 'NuGet',
        testingEcosystem: ['xUnit', 'NUnit'],
        deploymentOptions: ['Self-contained single-file executable', 'Docker container'],
        knownLimitations: ['Slightly larger runtime baseline than Go or Rust'],
        documentationReference: 'https://dotnet.microsoft.com',
        compatibilityStatus: 'candidate'
      },
      {
        id: 'java_systems',
        displayName: 'Java 21 LTS (Spring Boot)',
        category: 'backend',
        supportedPlatforms: ['cross_platform', 'linux', 'windows', 'cloud'],
        programmingLanguages: ['java'],
        projectTypes: ['api_service', 'backend_service', 'saas', 'fullstack'],
        runtimeRequirements: ['Java Runtime Environment (JRE) >= 21'],
        buildTooling: ['Maven', 'Gradle'],
        packageManager: 'Maven Central',
        testingEcosystem: ['JUnit 5', 'Mockito', 'Testcontainers'],
        deploymentOptions: ['Executable JAR', 'GraalVM Native Image', 'Docker container'],
        knownLimitations: ['Higher JVM memory baseline; longer cold start without native compilation'],
        documentationReference: 'https://spring.io/projects/spring-boot',
        compatibilityStatus: 'candidate'
      },

      // ==========================================
      // CREATIVE & ENGINEERING & 3D
      // ==========================================
      {
        id: 'threejs_webgl',
        displayName: 'Three.js / WebGL / WebGPU',
        category: 'graphics_3d',
        supportedPlatforms: ['web'],
        programmingLanguages: ['typescript', 'javascript'],
        projectTypes: ['3d_application', 'creative_application', 'engineering_application', 'game_application'],
        runtimeRequirements: ['WebGL 2.0 or WebGPU supported browser GPU runtime'],
        buildTooling: ['Vite', 'GLSL Shader Bundler'],
        packageManager: 'npm',
        testingEcosystem: ['WebGL headless mocking', 'Playwright screenshot tests'],
        deploymentOptions: ['Static Web Hosting', 'Docker container'],
        knownLimitations: ['Client GPU performance dependent; WebGPU browser support evolving'],
        documentationReference: 'https://threejs.org',
        compatibilityStatus: 'verified'
      },
      {
        id: 'vulkan_opengl_native',
        displayName: 'Native Graphics (Vulkan / OpenGL 4.6)',
        category: 'graphics_3d',
        supportedPlatforms: ['windows', 'linux', 'cross_platform'],
        programmingLanguages: ['cpp', 'rust'],
        projectTypes: ['3d_application', 'game_application', 'engineering_application', 'multimedia_application'],
        compatibilityRequirements: ['Vulkan SDK or OpenGL driver', 'C++20 or Rust toolchain'],
        runtimeRequirements: ['Physical or virtualized GPU with hardware acceleration'],
        buildTooling: ['CMake', 'glslc shader compiler'],
        packageManager: 'vcpkg / cargo',
        testingEcosystem: ['Headless GPU testing frames'],
        deploymentOptions: ['Native executable with compiled SPIR-V shaders'],
        knownLimitations: ['Vulkan is verbose and requires explicit synchronization and memory management'],
        documentationReference: 'https://www.vulkan.org',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'blender_python_api',
        displayName: 'Blender Python API (bpy)',
        category: 'graphics_3d',
        supportedPlatforms: ['cross_platform', 'windows', 'linux', 'macos'],
        programmingLanguages: ['python'],
        projectTypes: ['3d_application', 'creative_application', 'automation_tool', 'engineering_application'],
        runtimeRequirements: ['Blender >= 4.0 standalone installation with embedded Python'],
        buildTooling: ['Blender CLI runner'],
        packageManager: 'pip (Blender bundled)',
        testingEcosystem: ['pytest in Blender background mode'],
        deploymentOptions: ['Blender Addon (.zip) or headless script runner'],
        knownLimitations: ['Must be executed inside the Blender runtime process or via headless blender -b'],
        documentationReference: 'https://docs.blender.org/api/current/',
        compatibilityStatus: 'external_runtime_required'
      },
      {
        id: 'python_graphics_cv',
        displayName: 'Python Graphics & Media (OpenCV / Pillow / MoviePy)',
        category: 'graphics_3d',
        supportedPlatforms: ['cross_platform', 'windows', 'linux', 'macos'],
        programmingLanguages: ['python'],
        projectTypes: ['creative_application', 'multimedia_application', 'data_application', 'automation_tool'],
        runtimeRequirements: ['Python >= 3.10', 'FFmpeg binaries for video processing'],
        buildTooling: ['pip', 'uv'],
        packageManager: 'pip',
        testingEcosystem: ['pytest'],
        deploymentOptions: ['Docker container with FFmpeg', 'PyInstaller executable'],
        knownLimitations: ['FFmpeg external binary dependencies must be present for video transcoding'],
        documentationReference: 'https://opencv.org',
        compatibilityStatus: 'external_runtime_required'
      }
    ];

    for (const item of list) {
      this.register(item);
    }
  }
}
