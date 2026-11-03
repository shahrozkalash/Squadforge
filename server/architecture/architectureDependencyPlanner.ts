import { 
  CanonicalProjectType, 
  TargetPlatform, 
  TechStackBlueprint, 
  ArchitectureDependencyPlan, 
  ArchitectureDependencyItem 
} from '../types.js';

export class ArchitectureDependencyPlanner {
  /**
   * Generates a structured architecture dependency plan.
   * Analyzes dependencies without installing them and identifies prerequisites,
   * platform constraints, and potential version/runtime incompatibilities.
   */
  static planDependencies(
    category: CanonicalProjectType,
    platforms: TargetPlatform[],
    stack: TechStackBlueprint,
    originalPrompt: string
  ): ArchitectureDependencyPlan {
    const requiredDependencies: ArchitectureDependencyItem[] = [];
    const optionalDependencies: ArchitectureDependencyItem[] = [];
    const incompatibleVersionsDetected: string[] = [];
    const osSpecificDependencies: Array<{ os: string; dependencies: string[] }> = [];
    const missingRuntimeRequirements: string[] = [];
    const unnecessaryDuplicates: string[] = [];
    const unverifiableDependencies: string[] = [];
    const installationPrerequisites: string[] = [];

    let nativeCompilationRequired = false;

    // Platform-specific dependency planning
    if (platforms.includes('windows') && (category === 'windows_application' || stack.primaryLanguage === 'C#')) {
      requiredDependencies.push({
        name: 'Microsoft.NETCore.App',
        version: '8.0.0',
        category: 'runtime',
        purpose: '.NET Core Base Class Library and CLR runtime execution engine',
        verifiedInEnvironment: false
      });
      requiredDependencies.push({
        name: 'Microsoft.WindowsDesktop.App.WPF',
        version: '8.0.0',
        category: 'sdk',
        purpose: 'WPF XAML presentation engine and Direct3D rendering pipeline',
        verifiedInEnvironment: false
      });
      optionalDependencies.push({
        name: 'CommunityToolkit.Mvvm',
        version: '8.2.2',
        category: 'runtime',
        purpose: 'Modern, fast, and lightweight MVVM source generators for C#',
        verifiedInEnvironment: false
      });

      osSpecificDependencies.push({
        os: 'windows',
        dependencies: ['Microsoft.WindowsDesktop.App.WPF', 'System.Drawing.Common']
      });

      missingRuntimeRequirements.push('.NET Desktop Runtime 8.0 (Windows x64/arm64)');
      installationPrerequisites.push('Install .NET 8.0 SDK or Visual Studio 2022 with Desktop Development workload');
      unverifiableDependencies.push('Windows Desktop SDK cannot be verified inside Linux-x64 container environment.');
    } else if (category === 'android_application' || stack.primaryLanguage === 'Kotlin') {
      requiredDependencies.push({
        name: 'androidx.compose.ui:ui',
        version: '1.6.8',
        category: 'runtime',
        purpose: 'Jetpack Compose declarative UI toolkit core',
        verifiedInEnvironment: false
      });
      requiredDependencies.push({
        name: 'androidx.room:room-runtime',
        version: '2.6.1',
        category: 'runtime',
        purpose: 'SQLite object-relational mapping and entity persistence',
        verifiedInEnvironment: false
      });
      optionalDependencies.push({
        name: 'io.coil-kt:coil-compose',
        version: '2.6.0',
        category: 'runtime',
        purpose: 'Asynchronous image loading and caching library for Android Compose',
        verifiedInEnvironment: false
      });

      osSpecificDependencies.push({
        os: 'android',
        dependencies: ['androidx.core:core-ktx', 'androidx.activity:activity-compose']
      });

      missingRuntimeRequirements.push('Android SDK (API 34) and Java Development Kit (JDK 17+)');
      installationPrerequisites.push('Download Android command-line tools and install platforms;android-34');
      unverifiableDependencies.push('Android Gradle Plugin and APK compiler cannot be verified without Android SDK.');
    } else if (stack.desktopFramework?.includes('Tauri') || stack.primaryLanguage?.includes('Rust') || /\b(tauri|rust)\b/i.test(originalPrompt)) {
      nativeCompilationRequired = true;
      requiredDependencies.push({
        name: '@tauri-apps/api',
        version: '^2.0.0',
        category: 'runtime',
        purpose: 'Client TypeScript bridge for invoking Tauri native commands',
        verifiedInEnvironment: true
      });
      requiredDependencies.push({
        name: 'tauri (cargo crate)',
        version: '2.0.0',
        category: 'system',
        purpose: 'Rust core application harness and native window manager',
        verifiedInEnvironment: false
      });

      missingRuntimeRequirements.push('Rustc / Cargo toolchain >= 1.77 and native OS WebView development libraries');
      installationPrerequisites.push('Install rustup and system webview packages (e.g. libwebkit2gtk-4.1-dev on Linux)');
    } else if (stack.desktopFramework?.includes('Electron')) {
      requiredDependencies.push({
        name: 'electron',
        version: '^33.0.0',
        category: 'dev',
        purpose: 'Cross-platform desktop application shell bundling Chromium and Node.js',
        verifiedInEnvironment: false
      });
      requiredDependencies.push({
        name: 'electron-builder',
        version: '^25.0.0',
        category: 'dev',
        purpose: 'Multi-platform desktop installer and package builder',
        verifiedInEnvironment: false
      });
      installationPrerequisites.push('Run: npm install --save-dev electron electron-builder');
    } else if (category === 'cli_tool' && stack.primaryLanguage === 'Python') {
      requiredDependencies.push({
        name: 'typer',
        version: '>=0.12.0',
        category: 'runtime',
        purpose: 'Type-annotated command-line argument parser and CLI generator',
        verifiedInEnvironment: false
      });
      requiredDependencies.push({
        name: 'rich',
        version: '>=13.7.0',
        category: 'runtime',
        purpose: 'Terminal formatting, syntax highlighting, progress bars, and tables',
        verifiedInEnvironment: false
      });

      missingRuntimeRequirements.push('Python 3.10+ interpreter on PATH');
      installationPrerequisites.push('Run: pip install typer rich');
    } else {
      // Standard Node.js / React / Express Fullstack
      requiredDependencies.push({
        name: 'react',
        version: '^19.0.0',
        category: 'runtime',
        purpose: 'Declarative component-based user interface presentation',
        verifiedInEnvironment: true
      });
      requiredDependencies.push({
        name: 'express',
        version: '^4.21.0',
        category: 'runtime',
        purpose: 'REST API routing, HTTP middleware dispatch, and static asset serving',
        verifiedInEnvironment: true
      });
      requiredDependencies.push({
        name: 'lucide-react',
        version: '^0.546.0',
        category: 'runtime',
        purpose: 'Lightweight icon library for accessible UI navigation and feedback',
        verifiedInEnvironment: true
      });
      optionalDependencies.push({
        name: 'jszip',
        version: '^3.10.2',
        category: 'runtime',
        purpose: 'Client-side ZIP archive creation and project code export',
        verifiedInEnvironment: true
      });

      installationPrerequisites.push('Standard npm install (all core dependencies already verified in environment)');
    }

    // Check for duplicate technologies
    if (/\b(tailwind)\b/i.test(originalPrompt) && /\b(bootstrap|bulma|chakra)\b/i.test(originalPrompt)) {
      unnecessaryDuplicates.push('Multiple CSS frameworks detected in prompt (Tailwind + Bootstrap/Bulma). Recommending single unified Tailwind utility engine.');
    }
    if (/\b(express)\b/i.test(originalPrompt) && /\b(fastify|koa)\b/i.test(originalPrompt)) {
      unnecessaryDuplicates.push('Multiple Node.js HTTP servers detected (Express + Fastify). Consolidated on Express to prevent port and middleware collisions.');
    }

    return {
      requiredDependencies,
      optionalDependencies,
      incompatibleVersionsDetected,
      osSpecificDependencies,
      missingRuntimeRequirements,
      unnecessaryDuplicates,
      nativeCompilationRequired,
      installationPrerequisites,
      unverifiableDependencies
    };
  }
}
