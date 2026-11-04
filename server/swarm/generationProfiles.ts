import { 
  GenerationProfile, 
  GenerationProfileType, 
  GenerationProfilePlatformConstraints 
} from '../types.js';

export class GenerationProfileRegistry {
  private static profiles: Map<GenerationProfileType, GenerationProfile> = new Map();

  static {
    this.registerDefaults();
  }

  static register(profile: GenerationProfile): void {
    this.profiles.set(profile.id, profile);
  }

  static get(id: GenerationProfileType): GenerationProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      return this.profiles.get('website_and_web_app')!;
    }
    return profile;
  }

  static getAll(): GenerationProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Intelligently selects the best-matching generation profile based on prompt keywords,
   * requirements, and optional projectType hint.
   */
  static matchProfileForRequest(userPrompt: string, projectType?: string): GenerationProfile {
    const text = `${userPrompt} ${projectType || ''}`.toLowerCase();

    // 1. Mobile Android
    if (text.includes('android') || text.includes('apk') || text.includes('mobile app') || text.includes('kotlin') || text.includes('jetpack compose')) {
      return this.get('android_mobile_application');
    }

    // 2. Desktop
    if (text.includes('desktop') || text.includes('electron') || text.includes('tauri') || text.includes('windows app') || text.includes('macos app')) {
      return this.get('desktop_application');
    }

    // 3. CLI / Dev Tool
    if (text.includes('cli') || text.includes('command line') || text.includes('terminal tool') || text.includes('utility script') || text.includes('developer tool')) {
      return this.get('cli_tool_developer_utility');
    }

    // 4. Automation / Workflow
    if (text.includes('automation') || text.includes('workflow') || text.includes('cron') || text.includes('bot') || text.includes('scraper') || text.includes('webhook handler')) {
      return this.get('automation_software');
    }

    // 5. Data Processing / ETL
    if (text.includes('data processing') || text.includes('etl') || text.includes('analytics pipeline') || text.includes('csv parse') || text.includes('data pipeline') || text.includes('aggregation')) {
      return this.get('data_processing_application');
    }

    // 6. Multimedia & Audio/Video
    if (text.includes('audio') || text.includes('synthesizer') || text.includes('waveform') || text.includes('sound') || text.includes('video') || text.includes('media editor') || text.includes('web audio') || text.includes('visualizer')) {
      return this.get('multimedia_application');
    }

    // 7. Games & Creative
    if (text.includes('game') || text.includes('arcade') || text.includes('three.js') || text.includes('webgl') || text.includes('puzzle') || text.includes('rpg') || text.includes('canvas')) {
      return this.get('game_creative_application');
    }

    // 8. E-commerce
    if (text.includes('ecommerce') || text.includes('e-commerce') || text.includes('store') || text.includes('cart') || text.includes('checkout') || text.includes('product catalog') || text.includes('shopify')) {
      return this.get('ecommerce_app');
    }

    // 9. SaaS Platform
    if (text.includes('saas') || text.includes('dashboard') || text.includes('metrics') || text.includes('multi-tenant') || text.includes('kpi') || text.includes('portal') || text.includes('admin panel')) {
      return this.get('saas_platform');
    }

    // 10. REST API / Backend
    if (text.includes('api') || text.includes('rest') || text.includes('backend') || text.includes('microservice') || text.includes('endpoints') || text.includes('fastify') || text.includes('express service')) {
      return this.get('rest_api_backend');
    }

    // Default Web
    return this.get('website_and_web_app');
  }

  private static registerDefaults(): void {
    // 1. Websites and Web Applications
    this.register({
      id: 'website_and_web_app',
      displayName: 'Websites & Web Applications',
      category: 'Web',
      description: 'Responsive web applications, modern landing pages, marketing sites, and full-stack interactive client experiences.',
      architectureOverview: 'Client-first React SPA with Vite, modular Tailwind styling, responsive layouts, client route views, and REST API integration.',
      defaultFileOrganization: [
        'src/types/index.ts',
        'src/components/Header.tsx',
        'src/components/Hero.tsx',
        'src/components/Navigation.tsx',
        'src/components/Footer.tsx',
        'src/App.tsx',
        'src/index.css'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react', 'clsx', 'tailwind-merge'],
      requiredContracts: [
        'ComponentProps',
        'NavigationRoute',
        'ThemeConfig'
      ],
      codingConventions: [
        'Functional React components with TypeScript interfaces',
        'Semantic HTML elements (header, nav, main, section, footer)',
        'Defensive props destructuring with default fallbacks',
        'Utility-first Tailwind styling with dark mode support'
      ],
      validationRules: [
        'Must compile without TypeScript errors',
        'Must provide accessible ARIA attributes for interactive controls',
        'Root App.tsx must render cleanly with fallback state'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser', 'node'],
        recommendedPackaging: 'Web SPA (Vite / React)'
      }
    });

    // 2. SaaS Platforms
    this.register({
      id: 'saas_platform',
      displayName: 'SaaS Platforms & Dashboards',
      category: 'Cloud / Business',
      description: 'Multi-tenant SaaS dashboards, analytics portals, telemetry charts, role-based access control, and workspace configurations.',
      architectureOverview: 'Component-driven dashboard with sidebar navigation, metric cards, reactive tables, search/filter controls, and role-based views.',
      defaultFileOrganization: [
        'src/types/saas.ts',
        'src/components/Sidebar.tsx',
        'src/components/MetricCards.tsx',
        'src/components/DataTable.tsx',
        'src/components/AuditLogView.tsx',
        'src/components/SettingsModal.tsx',
        'src/App.tsx'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react', 'date-fns'],
      requiredContracts: [
        'UserProfile',
        'WorkspaceOrganization',
        'MetricSummary',
        'DataTableColumn',
        'AuditLogEntry'
      ],
      codingConventions: [
        'Strict tenant-isolation data scopes',
        'Consistent status badges and color tokens',
        'Paginated or virtualized data structures',
        'Clean empty, loading, and error states across all widgets'
      ],
      validationRules: [
        'Must define complete data models and contracts',
        'Must sanitize filter/search inputs',
        'Must not hardcode tenant IDs or user credentials'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser', 'node'],
        recommendedPackaging: 'Full-stack SaaS SPA'
      }
    });

    // 3. E-commerce Applications
    this.register({
      id: 'ecommerce_app',
      displayName: 'E-commerce Applications',
      category: 'Commerce',
      description: 'Online store fronts, product catalogs, shopping carts, checkout calculations, order history, and payment review workflows.',
      architectureOverview: 'State-driven shopping experience with persistent cart store, category filtering, product modals, price computation, and validation.',
      defaultFileOrganization: [
        'src/types/ecommerce.ts',
        'src/components/ProductCatalog.tsx',
        'src/components/ProductCard.tsx',
        'src/components/CartDrawer.tsx',
        'src/components/CheckoutModal.tsx',
        'src/context/CartContext.tsx',
        'src/utils/pricing.ts'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react'],
      requiredContracts: [
        'ProductItem',
        'CartItem',
        'OrderSummary',
        'ShippingAddress',
        'PriceCalculation'
      ],
      codingConventions: [
        'Deterministic floating-point or cents-based currency math',
        'Atomic cart state operations (add, remove, quantity increment)',
        'Input validation for shipping and billing addresses'
      ],
      validationRules: [
        'Unit tests for discount and tax calculations',
        'Subtotal + tax + shipping strictly equals total',
        'Cart quantities cannot be negative or NaN'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser', 'node'],
        recommendedPackaging: 'E-commerce Storefront'
      }
    });

    // 4. REST APIs and Backend Systems
    this.register({
      id: 'rest_api_backend',
      displayName: 'REST APIs & Backend Systems',
      category: 'Backend',
      description: 'Robust server-side REST APIs, middleware pipelines, authentication gates, rate limiters, and structured JSON responses.',
      architectureOverview: 'Modular Express or Fastify backend architecture with controllers, route definitions, error handling middleware, and storage adapters.',
      defaultFileOrganization: [
        'server/routes/api.ts',
        'server/controllers/resourceController.ts',
        'server/middleware/authMiddleware.ts',
        'server/middleware/rateLimiter.ts',
        'server/middleware/errorHandler.ts',
        'server/types/api.ts'
      ],
      typicalDependencies: ['express', 'cookie-parser', 'dotenv', 'bcryptjs'],
      requiredContracts: [
        'ApiSuccessResponse',
        'ApiErrorResponse',
        'RequestContext',
        'AuthTokenPayload'
      ],
      codingConventions: [
        'Consistent envelope: { success: boolean, data?: T, error?: string }',
        'Standard HTTP status codes (200, 201, 400, 401, 403, 404, 500)',
        'Explicit error handling without crashing process',
        'Defensive parameter parsing and type guarding'
      ],
      validationRules: [
        'All endpoints must have error-handling wrappers',
        'No sensitive server secrets exposed in JSON payloads',
        'Must bind to 0.0.0.0 and adhere to container port constraints'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['node'],
        recommendedPackaging: 'Node.js Express / Fastify Server'
      }
    });

    // 5. Desktop Applications
    this.register({
      id: 'desktop_application',
      displayName: 'Desktop Applications (Electron / Tauri)',
      category: 'Desktop',
      description: 'Cross-platform desktop application shells with IPC bridges, window frame controls, and offline-first desktop UX.',
      architectureOverview: 'Two-tier architecture: Main process (Node/Electron IPC bridge) and Renderer process (React UI with desktop-native layout).',
      defaultFileOrganization: [
        'src/desktop/ipcBridge.ts',
        'src/desktop/WindowControls.tsx',
        'src/components/DesktopLayout.tsx',
        'src/types/desktop.ts',
        'electron/main.ts',
        'electron/preload.ts'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react'],
      requiredContracts: [
        'IpcBridgeApi',
        'DesktopWindowState',
        'NativeFilePickerResult',
        'SystemNotification'
      ],
      codingConventions: [
        'Context-isolated preload script for Electron security',
        'Graceful web-preview fallback when Electron main process is not present',
        'Titlebar drag regions and window minimize/maximize controls'
      ],
      validationRules: [
        'IPC communication must use safe typed invoke/handle channels',
        'Must provide responsive web simulation in browser environment'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['electron', 'browser_simulation', 'node'],
        limitationNotice: 'In web preview container, desktop-native window frame and file-system APIs run via simulated IPC mock adapter. Full desktop binary packaging requires Electron/Tauri build tooling on host OS.',
        recommendedPackaging: 'Electron / Tauri App'
      }
    });

    // 6. Android and Mobile Applications
    this.register({
      id: 'android_mobile_application',
      displayName: 'Android & Mobile Applications',
      category: 'Mobile',
      description: 'Mobile applications with touch gestures, bottom navigation, mobile drawer navigation, and responsive touch viewports.',
      architectureOverview: 'Touch-optimized mobile UI layout with bottom navigation tabs, pull-to-refresh interactions, and responsive mobile container simulation.',
      defaultFileOrganization: [
        'src/mobile/MobileLayout.tsx',
        'src/mobile/BottomTabBar.tsx',
        'src/mobile/TouchGestures.ts',
        'src/types/mobile.ts',
        'src/components/MobileHeader.tsx'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react'],
      requiredContracts: [
        'MobileNavigationTab',
        'TouchGestureEvent',
        'MobileDeviceDimensions',
        'PushNotificationConfig'
      ],
      codingConventions: [
        '44px minimum touch targets for buttons and interactive controls',
        'Safe-area padding (inset top / bottom for status bar and home indicator)',
        'Swipeable drawer and sheet components with spring physics'
      ],
      validationRules: [
        'Mobile viewport simulation must render responsive layout within 375-430px widths',
        'No desktop-only hover dependencies without touch alternatives'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser_simulation', 'pwa', 'capacitor'],
        limitationNotice: 'Web runtime provides mobile viewport simulation, touch event emulation, and PWA capabilities. Native APK or AAB compilation requires Android Studio/Gradle toolchain.',
        recommendedPackaging: 'Capacitor / PWA / Android Webview'
      }
    });

    // 7. CLI Tools and Developer Utilities
    this.register({
      id: 'cli_tool_developer_utility',
      displayName: 'CLI Tools & Developer Utilities',
      category: 'Developer Tools',
      description: 'Command-line utilities, argument parsers, terminal color formatting, interactive prompts, and developer automation scripts.',
      architectureOverview: 'Command pattern CLI executable with subcommands, option parsing, stdin/stdout piping, and ANSI terminal color formatting.',
      defaultFileOrganization: [
        'bin/cli.ts',
        'src/cli/commandParser.ts',
        'src/cli/commands/run.ts',
        'src/cli/commands/init.ts',
        'src/cli/formatter.ts',
        'src/types/cli.ts'
      ],
      typicalDependencies: ['tsx', 'dotenv'],
      requiredContracts: [
        'CliCommand',
        'CliOption',
        'CliExecutionResult',
        'TerminalFormatOptions'
      ],
      codingConventions: [
        'Standard exit codes (0 = success, 1 = user error, 2 = system error)',
        'Informative --help and --version flags',
        'Non-blocking stream processing with backpressure awareness'
      ],
      validationRules: [
        'CLI entry must include shebang (#!/usr/bin/env node) or package bin field',
        'Must handle missing arguments with clean help messages without unhandled stack traces'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['node'],
        recommendedPackaging: 'NPM Executable Binary / Node CLI'
      }
    });

    // 8. Automation Software
    this.register({
      id: 'automation_software',
      displayName: 'Automation Software & Workflow Engines',
      category: 'Automation',
      description: 'Scheduled task managers, webhook dispatchers, workflow pipelines, retry logic with backoff, and idempotent processors.',
      architectureOverview: 'Event-driven pipeline architecture with step execution, conditional branching, state persistence, and retry policies.',
      defaultFileOrganization: [
        'server/automation/workflowEngine.ts',
        'server/automation/stepExecutor.ts',
        'server/automation/scheduler.ts',
        'server/automation/webhookHandler.ts',
        'server/types/automation.ts'
      ],
      typicalDependencies: ['express', 'dotenv'],
      requiredContracts: [
        'WorkflowDefinition',
        'WorkflowStep',
        'WorkflowExecutionState',
        'RetryPolicy',
        'WebhookPayload'
      ],
      codingConventions: [
        'Idempotent step handlers with correlation IDs',
        'Exponential backoff with jitter on network operations',
        'Detailed execution log history with duration metrics'
      ],
      validationRules: [
        'Workflows must support cancellation and timeout aborts',
        'Failed steps must record full diagnostic context'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['node'],
        recommendedPackaging: 'Node.js Automation Engine'
      }
    });

    // 9. Data Processing Applications
    this.register({
      id: 'data_processing_application',
      displayName: 'Data Processing & ETL Applications',
      category: 'Data',
      description: 'ETL pipelines, stream processors, CSV/JSON transformers, aggregation analytics, and structured data validation.',
      architectureOverview: 'Pipeline transform pattern: Reader -> Validator -> Transformer -> Aggregator -> Sink / Exporter.',
      defaultFileOrganization: [
        'src/data/pipeline.ts',
        'src/data/transformers.ts',
        'src/data/validators.ts',
        'src/data/aggregators.ts',
        'src/types/dataProcessing.ts'
      ],
      typicalDependencies: ['date-fns'],
      requiredContracts: [
        'DataRecord',
        'TransformationRule',
        'ValidationSchema',
        'AggregationResult',
        'PipelineStats'
      ],
      codingConventions: [
        'Stream or batch processing to avoid high memory spikes',
        'Immutable data transformation (pure functions)',
        'Comprehensive error quarantine for malformed records'
      ],
      validationRules: [
        'Zero-division protection in aggregation calculators',
        'Malformed input rows must be quarantined rather than crashing pipeline'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['node', 'browser'],
        recommendedPackaging: 'Node / Web Data Engine'
      }
    });

    // 10. Games and Creative Applications
    this.register({
      id: 'game_creative_application',
      displayName: 'Games & Creative Applications',
      category: 'Gaming / Creative',
      description: '2D canvas games, physics simulations, particle engines, interactive creative art, score tracking, and game loop controllers.',
      architectureOverview: 'RequestAnimationFrame game loop with state management, input listener, update physics, and render pipeline.',
      defaultFileOrganization: [
        'src/game/GameEngine.ts',
        'src/game/GameCanvas.tsx',
        'src/game/entities/Player.ts',
        'src/game/entities/Obstacle.ts',
        'src/game/systems/Physics.ts',
        'src/game/systems/Sound.ts',
        'src/types/game.ts'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react'],
      requiredContracts: [
        'GameEntity',
        'Vector2D',
        'GameState',
        'CollisionBox',
        'ScoreRecord'
      ],
      codingConventions: [
        'Delta-time normalized movement independent of frame rate',
        'Canvas cleanup and animation loop cancellation on unmount',
        'Decoupled game logic from React render cycles'
      ],
      validationRules: [
        'Must clean up animation frames to prevent memory leaks',
        'Keyboard and touch input controls must be responsive'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser'],
        recommendedPackaging: 'HTML5 Canvas / WebGL Game'
      }
    });

    // 11. Multimedia Applications
    this.register({
      id: 'multimedia_application',
      displayName: 'Multimedia & Audio/Video Applications',
      category: 'Multimedia',
      description: 'Web Audio synthesizers, audio visualizers, video player controllers, waveform displays, and image filter manipulation.',
      architectureOverview: 'Web Audio API / Canvas pipeline with audio buffer analysis, real-time frequency FFT visualizer, and media controls.',
      defaultFileOrganization: [
        'src/multimedia/AudioPlayer.tsx',
        'src/multimedia/WaveformVisualizer.tsx',
        'src/multimedia/SoundSynthesizer.ts',
        'src/multimedia/VideoController.tsx',
        'src/types/multimedia.ts'
      ],
      typicalDependencies: ['react', 'react-dom', 'lucide-react'],
      requiredContracts: [
        'AudioTrack',
        'MediaPlaybackState',
        'VisualizerConfig',
        'AudioFilterSettings'
      ],
      codingConventions: [
        'Safe AudioContext initialization upon user interaction (gesture requirement)',
        'AnalyserNode frequency data mapping to canvas visualizer',
        'Volume clamping between 0.0 and 1.0'
      ],
      validationRules: [
        'AudioContext must be resumed only after user click to satisfy browser policy',
        'Canvas visualizer must properly handle zero or silence input'
      ],
      platformConstraints: {
        supported: true,
        supportedRuntimes: ['browser'],
        recommendedPackaging: 'Web Multimedia App'
      }
    });
  }
}
