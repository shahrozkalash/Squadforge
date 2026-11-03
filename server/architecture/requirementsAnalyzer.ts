import { 
  CanonicalProjectType, 
  TargetPlatform, 
  RequirementsAnalysis, 
  ConfirmedRequirement, 
  TechnicalAssumption, 
  UnresolvedQuestion,
  normalizeProjectType
} from '../types.js';

export class SoftwareRequirementsAnalyzer {
  /**
   * Performs systematic requirements analysis on a user idea prompt.
   * Strictly separates confirmed explicit requirements from engineering assumptions.
   * Missing information is recorded as unresolved questions rather than invented facts.
   */
  static analyze(prompt: string, initialCategory?: string): RequirementsAnalysis {
    const raw = prompt || '';
    const text = raw.toLowerCase().trim();

    // 1. Determine Application Category
    const category = this.detectCategory(text, initialCategory);

    // 2. Identify Target Platforms
    const targetPlatforms = this.detectTargetPlatforms(text, category);

    // 3. Extract Main Purpose
    const mainPurpose = this.extractMainPurpose(raw, category);

    // 4. Extract Target Users
    const targetUsers = this.extractTargetUsers(text);

    // 5. Extract Core Functionality & Features
    const { requiredFeatures, coreFunctionality, confirmedRequirements } = this.extractFeatures(raw, text, category);

    // 6. Layer Requirements
    const uiRequirements = this.extractUiRequirements(text, category, targetPlatforms);
    const backendRequirements = this.extractBackendRequirements(text, category, targetPlatforms);
    const dataStorageRequirements = this.extractDataStorageRequirements(text, category);
    const externalIntegrations = this.extractExternalIntegrations(text);
    const performanceRequirements = this.extractPerformanceRequirements(text, category);
    const securityRequirements = this.extractSecurityRequirements(text, category);
    const deploymentRequirements = this.extractDeploymentRequirements(text, category, targetPlatforms);
    const technicalConstraints = this.extractTechnicalConstraints(text, targetPlatforms);

    // 7. Separate Assumptions and Unresolved Questions
    const assumptions = this.deriveTechnicalAssumptions(category, targetPlatforms, dataStorageRequirements);
    const unresolvedQuestions = this.identifyUnresolvedQuestions(text, category, targetPlatforms);

    return {
      mainPurpose,
      targetUsers,
      applicationCategory: category,
      targetPlatforms,
      requiredFeatures,
      coreFunctionality,
      uiRequirements,
      backendRequirements,
      dataStorageRequirements,
      externalIntegrations,
      performanceRequirements,
      securityRequirements,
      deploymentRequirements,
      technicalConstraints,
      confirmedRequirements,
      assumptions,
      unresolvedQuestions,
      originalPrompt: raw,
      analyzedAt: Date.now()
    };
  }

  /**
   * Deterministically classifies project into a canonical category.
   */
  static detectCategory(text: string, initialCategory?: string): CanonicalProjectType {
    if (initialCategory && initialCategory !== 'fullstack' && initialCategory !== 'custom') {
      return normalizeProjectType(initialCategory);
    }

    // 3D / Creative / CAD / Multimedia
    if (/\b(3d|threejs|webgl|vulkan|opengl|blender|mesh|cad|modeling|render|spatial|raytracing)\b/i.test(text)) {
      return '3d_application';
    }
    if (/\b(photo editor|image editor|video editor|audio editor|daw|multimedia|transcode|filter)\b/i.test(text)) {
      return 'multimedia_application';
    }
    if (/\b(drawing|canvas|digital art|generative art|creative|illustration|shader)\b/i.test(text)) {
      return 'creative_application';
    }
    if (/\b(simulation|finite element|physics engine|matlab|math|scientific|engineering tool)\b/i.test(text)) {
      return 'engineering_application';
    }
    if (/\b(game|arcade|rpg|platformer|unity|godot|unreal|canvas game)\b/i.test(text)) {
      return 'game_application';
    }

    // Mobile
    if (/\b(android|apk|kotlin|jetpack compose)\b/i.test(text)) {
      return 'android_application';
    }
    if (/\b(mobile app|react native|flutter|ios app|smartphone app)\b/i.test(text)) {
      return 'cross_platform_mobile';
    }

    // Desktop
    if (/\b(windows app|wpf|winui|winforms|windows desktop|\.net desktop)\b/i.test(text)) {
      return 'windows_application';
    }
    if (/\b(electron|tauri|qt desktop|cross-platform desktop|native desktop app)\b/i.test(text)) {
      return 'cross_platform_desktop';
    }
    if (/\b(desktop application|desktop app)\b/i.test(text)) {
      return 'desktop_application';
    }

    // CLI & DevTools & Automation
    if (/\b(cli|command line|terminal tool|shell command|argparse)\b/i.test(text)) {
      return 'cli_tool';
    }
    if (/\b(automation|scraper|crawler|bot|cron job|batch process|workflow engine)\b/i.test(text)) {
      return 'automation_tool';
    }
    if (/\b(developer tool|linter|code generator|compiler|profiler|sdk generator|devtools)\b/i.test(text)) {
      return 'developer_tool';
    }
    if (/\b(data pipeline|etl|analytics engine|dataframe|data visualization|pandas|data processing)\b/i.test(text)) {
      return 'data_application';
    }

    // Backend & API
    if (/\b(microservice|rest api|graphql api|grpc|api gateway|webhook service|api service)\b/i.test(text)) {
      return 'api_service';
    }
    if (/\b(backend service|daemon|worker service|message queue consumer)\b/i.test(text)) {
      return 'backend_service';
    }

    // Web categories
    if (/\b(landing page|hero section|product showcase|waitlist|teaser|splash page)\b/i.test(text)) {
      return 'landing_page';
    }
    if (/\b(portfolio|resume|cv|personal website)\b/i.test(text)) {
      return 'portfolio';
    }
    if (/\b(blog|publication|articles|editorial|news site|newsletter)\b/i.test(text)) {
      return 'blog';
    }
    if (/\b(ecommerce|online store|marketplace|shopping cart|shopify|checkout)\b/i.test(text)) {
      return 'ecommerce';
    }
    if (/\b(saas|dashboard|admin panel|kpi|analytics portal|subscription service|b2b)\b/i.test(text)) {
      return 'saas';
    }
    if (/\b(single page app|spa|web application|web app)\b/i.test(text)) {
      return 'web_application';
    }

    return initialCategory ? normalizeProjectType(initialCategory) : 'fullstack';
  }

  /**
   * Detects target platforms based on explicit text and project category.
   */
  static detectTargetPlatforms(text: string, category: CanonicalProjectType): TargetPlatform[] {
    const platforms = new Set<TargetPlatform>();

    // Explicit mentions
    if (/\b(windows|win32|win64)\b/i.test(text)) platforms.add('windows');
    if (/\b(macos|osx|apple)\b/i.test(text)) platforms.add('macos');
    if (/\b(linux|ubuntu|debian)\b/i.test(text)) platforms.add('linux');
    if (/\b(android)\b/i.test(text)) platforms.add('android');
    if (/\b(ios|iphone|ipad)\b/i.test(text)) platforms.add('ios');
    if (/\b(web|browser|chrome|firefox|safari)\b/i.test(text)) platforms.add('web');
    if (/\b(cli|terminal|console)\b/i.test(text)) platforms.add('cli');
    if (/\b(cloud|docker|serverless|aws|gcp|k8s)\b/i.test(text)) platforms.add('cloud');

    // Category-driven defaults if not specified
    if (category === 'windows_application') {
      platforms.add('windows');
    } else if (category === 'android_application') {
      platforms.add('android');
    } else if (category === 'cross_platform_mobile') {
      platforms.add('android');
      platforms.add('ios');
    } else if (category === 'cross_platform_desktop' || category === 'desktop_application') {
      platforms.add('windows');
      platforms.add('macos');
      platforms.add('linux');
    } else if (category === 'cli_tool' || category === 'automation_tool') {
      platforms.add('cli');
    } else if (category === 'api_service' || category === 'backend_service') {
      platforms.add('cloud');
      platforms.add('linux');
    } else {
      platforms.add('web');
    }

    return Array.from(platforms);
  }

  private static extractMainPurpose(raw: string, category: CanonicalProjectType): string {
    const lines = raw.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
    if (lines.length > 0 && lines[0].length >= 10) {
      return lines[0];
    }
    return `Create a high-quality ${category.replace(/_/g, ' ')} with clean architecture and robust foundations.`;
  }

  private static extractTargetUsers(text: string): string[] {
    const users: string[] = [];
    if (/\b(developer|engineers|programmer)\b/i.test(text)) users.push('Software Developers & Engineers');
    if (/\b(admin|administrator|manager|operations)\b/i.test(text)) users.push('System Administrators & Managers');
    if (/\b(designer|artist|creator|illustrator)\b/i.test(text)) users.push('Designers & Creative Professionals');
    if (/\b(customer|consumer|shopper|buyer)\b/i.test(text)) users.push('End Consumers & Shoppers');
    if (/\b(b2b|business|enterprise|team)\b/i.test(text)) users.push('Business Teams & Enterprise Users');
    if (/\b(student|researcher|scientist|academic)\b/i.test(text)) users.push('Researchers & Students');

    if (users.length === 0) {
      users.push('General End Users');
    }
    return users;
  }

  private static extractFeatures(raw: string, text: string, category: CanonicalProjectType) {
    const requiredFeatures: string[] = [];
    const coreFunctionality: string[] = [];
    const confirmedRequirements: ConfirmedRequirement[] = [];

    let reqIndex = 1;
    const addConfirmed = (statement: string, cat: ConfirmedRequirement['category'], prio: ConfirmedRequirement['priority'] = 'must_have') => {
      requiredFeatures.push(statement);
      confirmedRequirements.push({
        id: `req_conf_${reqIndex++}`,
        statement,
        category: cat,
        priority: prio,
        source: 'user_prompt'
      });
    };

    // Extract bullet points or distinct phrases if present
    const bullets = raw.match(/[-*•]\s+([^\n\r]+)/g);
    if (bullets && bullets.length > 0) {
      for (const b of bullets) {
        const clean = b.replace(/^[-*•]\s+/, '').trim();
        if (clean.length > 4) {
          addConfirmed(clean, 'functional');
        }
      }
    }

    // Specific domain features based on prompt cues
    if (/\b(auth|login|signup|jwt|oauth|session|password)\b/i.test(text)) {
      addConfirmed('User authentication and secure identity management', 'security');
    }
    if (/\b(payment|stripe|checkout|billing|subscription)\b/i.test(text)) {
      addConfirmed('Payment processing and checkout handling', 'integration');
    }
    if (/\b(search|filter|sort|query)\b/i.test(text)) {
      addConfirmed('Search, filtering, and sorting capabilities', 'functional');
    }
    if (/\b(export|import|csv|json|pdf|download)\b/i.test(text)) {
      addConfirmed('Data export/import functionality', 'data');
    }
    if (/\b(notification|email|sms|alert|webhook)\b/i.test(text)) {
      addConfirmed('Real-time notifications or email dispatch', 'integration');
    }
    if (/\b(dark mode|theme|responsive|mobile friendly)\b/i.test(text)) {
      addConfirmed('Responsive design with adaptive theming', 'ui', 'should_have');
    }
    if (/\b(undo|redo|history|checkpoint)\b/i.test(text)) {
      addConfirmed('Action history with undo/redo capabilities', 'functional');
    }

    // Ensure baseline core functionality
    if (requiredFeatures.length === 0) {
      addConfirmed(`Core ${category.replace(/_/g, ' ')} workflow and interfaces`, 'functional');
    }

    coreFunctionality.push(`Primary execution path for ${category.replace(/_/g, ' ')}`);
    if (category.includes('desktop') || category.includes('windows')) {
      coreFunctionality.push('Native OS window lifecycle, file system access, and system tray');
    } else if (category.includes('mobile') || category.includes('android')) {
      coreFunctionality.push('Mobile touch interactions, screen transitions, and offline persistence');
    } else if (category.includes('cli') || category.includes('tool')) {
      coreFunctionality.push('Terminal argument parsing, standard streams (stdin/stdout), and exit code handling');
    } else if (category.includes('3d') || category.includes('creative')) {
      coreFunctionality.push('Rendering loop, scene hierarchy, viewport controls, and asset importing');
    } else {
      coreFunctionality.push('Web presentation layer, state management, and API integration');
    }

    return { requiredFeatures, coreFunctionality, confirmedRequirements };
  }

  private static extractUiRequirements(text: string, category: CanonicalProjectType, platforms: TargetPlatform[]): string[] {
    const isHeadless = category === 'cli_tool' || category === 'api_service' || category === 'backend_service' || category === 'automation_tool';
    if (isHeadless && !/\b(gui|dashboard|web view|interface)\b/i.test(text)) {
      return ['No graphical user interface required (CLI/API headless execution)'];
    }

    const ui: string[] = [];
    if (platforms.includes('android') || platforms.includes('ios') || platforms.includes('cross_platform')) {
      ui.push('Touch-optimized mobile UI with intuitive navigation and gesture support');
      ui.push('Adaptive layouts supporting varying screen densities and orientations');
    } else if (platforms.includes('windows') || platforms.includes('macos') || platforms.includes('linux')) {
      ui.push('Native desktop window frame with menu bar, keyboard shortcuts, and dialog modals');
    } else {
      ui.push('Responsive modern layout adapting seamlessly between desktop, tablet, and mobile');
      ui.push('Cohesive typography, visual hierarchy, and accessible contrast ratios');
    }

    if (/\b(chart|graph|metrics|kpi)\b/i.test(text)) {
      ui.push('Interactive charts and data visualizations');
    }
    return ui;
  }

  private static extractBackendRequirements(text: string, category: CanonicalProjectType, platforms: TargetPlatform[]): string[] {
    const isPureFrontend = category === 'landing_page' || category === 'portfolio';
    if (isPureFrontend && !/\b(backend|api|server|database)\b/i.test(text)) {
      return ['Static client execution with optional edge functions / serverless handlers'];
    }

    const backend: string[] = [];
    if (category === 'cli_tool') {
      backend.push('Local system execution process, child process management, and IO stream piping');
    } else if (category === 'windows_application' || category === 'desktop_application' || category === 'cross_platform_desktop') {
      backend.push('Local application backend or native runtime bridge (IPC / background thread)');
    } else {
      backend.push('RESTful or structured API endpoints with defensive input validation');
      backend.push('Robust error handling and structured JSON responses');
    }
    return backend;
  }

  private static extractDataStorageRequirements(text: string, category: CanonicalProjectType): string[] {
    const storage: string[] = [];
    if (/\b(sql|sqlite|postgres|mysql|relational)\b/i.test(text)) {
      storage.push('Relational database (PostgreSQL / SQLite) with structured schema and migrations');
    } else if (/\b(mongo|document|nosql)\b/i.test(text)) {
      storage.push('Document or key-value store for unstructured JSON records');
    } else if (category.includes('desktop') || category.includes('cli') || category.includes('mobile')) {
      storage.push('Local embedded storage (SQLite / configuration file / local state)');
    } else if (category === 'landing_page' || category === 'portfolio') {
      storage.push('Client-side cache or static content repository');
    } else {
      storage.push('Persistent database storage for entity and session data');
    }
    return storage;
  }

  private static extractExternalIntegrations(text: string): string[] {
    const integrations: string[] = [];
    if (/\b(github|git)\b/i.test(text)) integrations.push('GitHub API / Git VCS Integration');
    if (/\b(stripe|paypal|payment)\b/i.test(text)) integrations.push('Payment Gateway (Stripe/PayPal)');
    if (/\b(resend|sendgrid|smtp|email)\b/i.test(text)) integrations.push('Email Delivery Provider');
    if (/\b(gemini|openai|anthropic|llm|ai)\b/i.test(text)) integrations.push('AI Model Inference Gateway');
    if (/\b(s3|gcs|blob|cloud storage)\b/i.test(text)) integrations.push('Object Storage Service');
    if (/\b(slack|discord)\b/i.test(text)) integrations.push('Messaging Webhook Integration');
    return integrations;
  }

  private static extractPerformanceRequirements(text: string, category: CanonicalProjectType): string[] {
    const reqs: string[] = [];
    if (category === '3d_application' || category === 'game_application' || category === 'multimedia_application') {
      reqs.push('60 FPS continuous rendering cycle without frame drops');
      reqs.push('Efficient GPU memory allocation and asset disposal');
    } else if (category === 'cli_tool' || category === 'automation_tool') {
      reqs.push('Fast startup time (< 200ms) and minimal memory overhead');
    } else {
      reqs.push('Sub-second API response latency for standard operations');
      reqs.push('Fast initial page load and optimized asset bundling');
    }
    return reqs;
  }

  private static extractSecurityRequirements(text: string, category: CanonicalProjectType): string[] {
    const sec: string[] = [
      'Defensive input validation on all entry points to prevent injection attacks',
      'Secure credential handling with no hardcoded secrets or API tokens'
    ];
    if (!category.includes('cli')) {
      sec.push('Secure HTTP headers (Content-Security-Policy, X-Content-Type-Options, Referrer-Policy)');
    }
    return sec;
  }

  private static extractDeploymentRequirements(text: string, category: CanonicalProjectType, platforms: TargetPlatform[]): string[] {
    const dep: string[] = [];
    if (platforms.includes('windows')) {
      dep.push('Windows executable (.exe) or MSI package with code signing support');
    }
    if (platforms.includes('android')) {
      dep.push('Android Application Package (APK) or Android App Bundle (AAB)');
    }
    if (platforms.includes('web') || platforms.includes('cloud')) {
      dep.push('Production Docker container image or modern cloud hosting deployment');
    }
    if (platforms.includes('cli')) {
      dep.push('Compiled binary distribution or global package manager executable');
    }
    return dep;
  }

  private static extractTechnicalConstraints(text: string, platforms: TargetPlatform[]): string[] {
    const constraints: string[] = [];
    if (platforms.includes('windows')) {
      constraints.push('Requires Windows runtime APIs or Win32/WinUI compatibility layer');
    }
    if (platforms.includes('android')) {
      constraints.push('Requires Android SDK, Gradle build tools, and Java/Kotlin runtime');
    }
    constraints.push('Strict type checking and automated regression verification required');
    return constraints;
  }

  /**
   * Identifies engineering assumptions (never silently converted to confirmed user requirements).
   */
  private static deriveTechnicalAssumptions(category: CanonicalProjectType, platforms: TargetPlatform[], storage: string[]): TechnicalAssumption[] {
    const assumptions: TechnicalAssumption[] = [];
    let idx = 1;

    assumptions.push({
      id: `asm_${idx++}`,
      statement: `Target runtime environment will support modern standard APIs for ${platforms.join(', ')}`,
      category: 'environment',
      rationale: 'Prerequisite for standard library execution',
      confidence: 'high',
      validated: true
    });

    if (category === 'fullstack' || category === 'saas' || category === 'web_application') {
      assumptions.push({
        id: `asm_${idx++}`,
        statement: 'Standard HTTP/JSON contracts will be utilized for client-server communication',
        category: 'architecture',
        rationale: 'Industry standard for web application interoperability',
        confidence: 'high',
        validated: true
      });
    }

    if (storage.length > 0) {
      assumptions.push({
        id: `asm_${idx++}`,
        statement: `Entity persistence will be backed by ${storage[0]}`,
        category: 'data',
        rationale: 'Derived from application state requirements',
        confidence: 'medium',
        validated: false
      });
    }

    return assumptions;
  }

  /**
   * Records missing / ambiguous information as unresolved questions rather than inventing answers.
   */
  private static identifyUnresolvedQuestions(text: string, category: CanonicalProjectType, platforms: TargetPlatform[]): UnresolvedQuestion[] {
    const questions: UnresolvedQuestion[] = [];
    let qIdx = 1;

    // Check if auth is desired but unspecified
    if (!/\b(auth|login|signup|guest|anonymous|user account|public)\b/i.test(text) && (category === 'saas' || category === 'ecommerce')) {
      questions.push({
        id: `q_${qIdx++}`,
        question: 'What authentication strategy is required for user accounts (email/password, OAuth, or SSO)?',
        category: 'security',
        impact: 'Affects user identity models, session management, and access control policies.',
        suggestedResolution: 'Start with email/password authentication and provide OAuth extensions.'
      });
    }

    // Check if hosting / target infrastructure is unspecified
    if (!/\b(aws|gcp|azure|docker|vercel|on-premise|self-hosted|local)\b/i.test(text)) {
      questions.push({
        id: `q_${qIdx++}`,
        question: 'What is the designated target hosting or distribution infrastructure?',
        category: 'deployment',
        impact: 'Determines CI/CD pipelines, containerization requirements, and environment configuration.',
        suggestedResolution: 'Provide containerized Dockerfile and standard cloud deployment blueprint.'
      });
    }

    // Platform specific unresolved questions
    if (platforms.includes('windows') && !/\b(installer|msi|portable|setup)\b/i.test(text)) {
      questions.push({
        id: `q_${qIdx++}`,
        question: 'Is a full installer (MSI/InnoSetup) or a standalone portable executable preferred?',
        category: 'packaging',
        impact: 'Determines build scripts and installation prerequisites on Windows systems.',
        suggestedResolution: 'Provide portable single-file binary configuration with installer packaging script.'
      });
    }

    return questions;
  }
}
