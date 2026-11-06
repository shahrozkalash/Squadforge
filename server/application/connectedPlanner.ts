import crypto from 'node:crypto';
import {
  FullStackApplicationPlan,
  ApplicationTopology,
  ConnectedDataFlow,
  PlannedTieredFile,
  CanonicalProjectType,
  AgentRole,
  ProjectFile,
  TechStackConfig,
  DatabaseTableDefinition,
  ApiEndpointDefinition,
  FrontendComponentDefinition,
  ConfigurationVariableDefinition,
  ApplicationProjectMode
} from '../types.js';
import { SoftwareRequirementsAnalyzer } from '../architecture/requirementsAnalyzer.js';
import { IntelligentStackSelector } from '../architecture/stackSelector.js';

export interface PlanApplicationOptions {
  buildId: string;
  userRequest: string;
  existingFiles?: ProjectFile[];
  category?: CanonicalProjectType;
  stack?: TechStackConfig;
  forceMode?: ApplicationProjectMode;
}

export class ConnectedApplicationPlanner {
  /**
   * Plans a fully connected, full-stack application topology spanning database, backend APIs,
   * authentication, frontend client and components, and automated integration tests.
   */
  static planApplication(options: PlanApplicationOptions): FullStackApplicationPlan {
    const {
      buildId,
      userRequest,
      existingFiles = [],
      category,
      stack,
      forceMode
    } = options;

    const reqLower = userRequest.toLowerCase();

    // 1. Determine Project Mode: Greenfield vs Modification
    const mode: ApplicationProjectMode = forceMode || this.detectProjectMode(existingFiles);

    // 2. Identify Requirements & Canonical Category
    const detectedCategory = category || SoftwareRequirementsAnalyzer.detectCategory(reqLower);

    // 3. Extract Core Entities & Domain Name
    const domainEntities = this.extractDomainEntities(userRequest);
    const primaryEntity = domainEntities[0] || 'Item';
    const primaryPlural = this.pluralize(primaryEntity.toLowerCase());
    const appName = this.deriveApplicationName(userRequest, primaryEntity);

    // 4. Derive Authentication & Security Needs
    const hasAuth = forceMode === 'greenfield'
      ? (/\b(auth|login|signup|user|session|jwt|password|account|credential|register)\b/i.test(userRequest) ||
         detectedCategory === 'saas' || detectedCategory === 'ecommerce')
      : this.hasExistingAuth(existingFiles) || /\b(auth|login|user|session)\b/i.test(userRequest);

    // 5. Build Database Topology (Tables, Schemas, Migrations)
    const databaseTopology = this.buildDatabaseTopology(domainEntities, hasAuth, mode, existingFiles);

    // 6. Build Backend Topology (Routes, Middleware, Services, Controllers)
    const backendTopology = this.buildBackendTopology(domainEntities, hasAuth, primaryPlural);

    // 7. Build Frontend Topology (Client API, Hooks, Responsive UI Primitives, Views)
    const frontendTopology = this.buildFrontendTopology(domainEntities, hasAuth, primaryEntity, primaryPlural);

    // 8. Build Security & Configuration Topologies
    const securityTopology = {
      authMechanism: 'session_cookie' as const,
      passwordHashing: 'bcryptjs' as const,
      roles: ['guest', 'user', 'admin'],
      protectedRoutes: hasAuth ? [`/api/${primaryPlural}`, `/api/${primaryPlural}/:id`, '/api/users/profile'] : []
    };

    const configurationTopology = {
      envExamplePath: '.env.example',
      envKeys: [
        { key: 'PORT', description: 'Application HTTP port (default 3000)', required: true, defaultValue: '3000' },
        { key: 'SQLITE_DB_PATH', description: 'Path to SQLite database file', required: false, defaultValue: 'squadforge.db' },
        { key: 'SESSION_SECRET', description: 'Cryptographic secret for session cookie signing', required: hasAuth, isSecret: true },
        { key: 'NODE_ENV', description: 'Runtime environment (development / production)', required: true, defaultValue: 'development' }
      ] as ConfigurationVariableDefinition[]
    };

    const topology: ApplicationTopology = {
      database: databaseTopology,
      backend: backendTopology,
      frontend: frontendTopology,
      security: securityTopology,
      configuration: configurationTopology
    };

    // 9. Build Connected End-to-End Data Flows
    const connectedFlows = this.buildConnectedFlows(domainEntities, primaryEntity, primaryPlural, hasAuth, mode);

    // 10. Build Strict Tiered File Plan
    const plannedFiles = this.buildTieredFilePlan(topology, mode, hasAuth, primaryEntity, primaryPlural);

    // 11. Build Dependency-Chained Multi-Agent Swarm Tasks
    const tasks = this.buildCoordinatedTasks(plannedFiles, appName, primaryEntity);

    return {
      id: `appplan_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId,
      mode,
      appName,
      description: `Full-stack connected application for: ${userRequest.slice(0, 100)}`,
      category: detectedCategory,
      topology,
      connectedFlows,
      plannedFiles,
      tasks,
      createdAt: Date.now()
    };
  }

  /**
   * Detects whether the current workspace is an existing project (modification) or empty (greenfield).
   */
  private static detectProjectMode(existingFiles: ProjectFile[]): ApplicationProjectMode {
    if (!existingFiles || existingFiles.length === 0) return 'greenfield';
    const substantiveFiles = existingFiles.filter(f =>
      !f.path.startsWith('.') &&
      f.path !== 'README.md' &&
      (f.path.endsWith('.ts') || f.path.endsWith('.tsx') || f.path.endsWith('.js') || f.path.endsWith('package.json'))
    );
    return substantiveFiles.length >= 3 ? 'modification' : 'greenfield';
  }

  private static hasExistingAuth(existingFiles: ProjectFile[]): boolean {
    return existingFiles.some(f =>
      f.path.includes('auth') ||
      (f.content && /requireAuth|bcrypt|sessionToken|jwt/i.test(f.content))
    );
  }

  /**
   * Identifies domain entities from the user prompt (e.g. Task, User, Product, Project, Order, Comment, Invoice).
   */
  private static extractDomainEntities(userRequest: string): string[] {
    const entities = new Set<string>();
    const text = userRequest.toLowerCase();

    const entityKeywords: Record<string, string> = {
      task: 'Task',
      project: 'Project',
      todo: 'Todo',
      user: 'User',
      member: 'Member',
      customer: 'Customer',
      product: 'Product',
      item: 'Item',
      order: 'Order',
      invoice: 'Invoice',
      note: 'Note',
      post: 'Post',
      article: 'Article',
      comment: 'Comment',
      board: 'Board',
      ticket: 'Ticket',
      issue: 'Issue',
      metric: 'Metric',
      feedback: 'Feedback',
      review: 'Review',
      message: 'Message',
      chat: 'Chat',
      event: 'Event',
      booking: 'Booking'
    };

    for (const [kw, entityName] of Object.entries(entityKeywords)) {
      const regex = new RegExp(`\\b${kw}s?\\b`, 'i');
      if (regex.test(text)) {
        entities.add(entityName);
      }
    }

    if (entities.size === 0) {
      entities.add('Item');
    }

    return Array.from(entities);
  }

  private static pluralize(word: string): string {
    if (word.endsWith('y') && !/[aeiou]y$/i.test(word)) {
      return word.slice(0, -1) + 'ies';
    }
    if (word.endsWith('s') || word.endsWith('sh') || word.endsWith('ch') || word.endsWith('x')) {
      return word + 'es';
    }
    return word + 's';
  }

  private static deriveApplicationName(userRequest: string, primaryEntity: string): string {
    const cleaned = userRequest.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const words = cleaned.split(/\s+/).slice(0, 4);
    if (words.length > 0 && words[0].length > 1) {
      return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    return `${primaryEntity} Hub`;
  }

  private static buildDatabaseTopology(
    entities: string[],
    hasAuth: boolean,
    mode: ApplicationProjectMode,
    existingFiles: ProjectFile[]
  ): ApplicationTopology['database'] {
    const tables: DatabaseTableDefinition[] = [];

    // User table if auth enabled
    if (hasAuth) {
      tables.push({
        name: 'users',
        description: 'User accounts and credentials for authenticated access',
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'email', type: 'TEXT', notNull: true },
          { name: 'password_hash', type: 'TEXT', notNull: true },
          { name: 'name', type: 'TEXT', notNull: true },
          { name: 'role', type: 'TEXT', notNull: true, defaultValue: "'user'" },
          { name: 'created_at', type: 'INTEGER', notNull: true },
          { name: 'updated_at', type: 'INTEGER', notNull: true }
        ],
        indices: ['idx_users_email']
      });

      tables.push({
        name: 'sessions',
        description: 'Cryptographically hashed active session records',
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'user_id', type: 'TEXT', notNull: true, references: 'users(id)' },
          { name: 'token_hash', type: 'TEXT', notNull: true },
          { name: 'expires_at', type: 'INTEGER', notNull: true },
          { name: 'created_at', type: 'INTEGER', notNull: true }
        ],
        indices: ['idx_sessions_user_id', 'idx_sessions_token_hash']
      });
    }

    // Entity tables
    for (const ent of entities) {
      if (ent === 'User' && hasAuth) continue;
      const tableName = this.pluralize(ent.toLowerCase());
      tables.push({
        name: tableName,
        description: `Persistent store for ${ent} entity records`,
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'title', type: 'TEXT', notNull: true },
          { name: 'description', type: 'TEXT' },
          { name: 'status', type: 'TEXT', notNull: true, defaultValue: "'active'" },
          { name: 'priority', type: 'TEXT', defaultValue: "'medium'" },
          { name: 'user_id', type: 'TEXT', references: hasAuth ? 'users(id)' : undefined },
          { name: 'metadata', type: 'TEXT' },
          { name: 'created_at', type: 'INTEGER', notNull: true },
          { name: 'updated_at', type: 'INTEGER', notNull: true }
        ],
        indices: [`idx_${tableName}_status`, `idx_${tableName}_created_at`]
      });
    }

    // Calculate migration filename based on mode and existing migration files
    const existingMigrationCount = existingFiles.filter(f => f.path.includes('/migrations/')).length;
    const migrationVersion = mode === 'modification' && existingMigrationCount > 0
      ? String(existingMigrationCount + 1).padStart(3, '0')
      : '001';

    return {
      engine: 'sqlite',
      schemaPath: 'server/db/schema.ts',
      migrationsDir: 'server/db/migrations',
      storePath: 'server/db/store.ts',
      migrationRunnerPath: 'server/db/migrationRunner.ts',
      tables
    };
  }

  private static buildBackendTopology(
    entities: string[],
    hasAuth: boolean,
    primaryPlural: string
  ): ApplicationTopology['backend'] {
    const endpoints: ApiEndpointDefinition[] = [
      {
        method: 'GET',
        path: '/api/health',
        summary: 'Health and readiness check verifying database and server uptime',
        authRequired: false,
        responseSchema: '{ status: string; timestamp: number; database: string }'
      }
    ];

    if (hasAuth) {
      endpoints.push(
        {
          method: 'POST',
          path: '/api/auth/register',
          summary: 'User registration with bcryptjs password hashing',
          authRequired: false,
          requestSchema: '{ email: string; password: string; name: string }',
          responseSchema: '{ user: SafeUser; token: string }',
          rateLimited: true
        },
        {
          method: 'POST',
          path: '/api/auth/login',
          summary: 'User authentication with rate-limited credential verification',
          authRequired: false,
          requestSchema: '{ email: string; password: string }',
          responseSchema: '{ user: SafeUser; token: string }',
          rateLimited: true
        },
        {
          method: 'POST',
          path: '/api/auth/logout',
          summary: 'Terminates active session and clears session cookie',
          authRequired: true,
          responseSchema: '{ success: boolean }'
        },
        {
          method: 'GET',
          path: '/api/auth/me',
          summary: 'Retrieves authenticated user profile details',
          authRequired: true,
          responseSchema: '{ user: SafeUser }'
        }
      );
    }

    // Endpoints for primary domain collection
    endpoints.push(
      {
        method: 'GET',
        path: `/api/${primaryPlural}`,
        summary: `List all ${primaryPlural} with optional filtering and pagination`,
        authRequired: hasAuth,
        responseSchema: `{ ${primaryPlural}: Array<any>; total: number }`
      },
      {
        method: 'POST',
        path: `/api/${primaryPlural}`,
        summary: `Create a new ${primaryPlural.slice(0, -1)} with input validation`,
        authRequired: hasAuth,
        requestSchema: '{ title: string; description?: string; priority?: string }',
        responseSchema: `{ ${primaryPlural.slice(0, -1)}: any }`
      },
      {
        method: 'GET',
        path: `/api/${primaryPlural}/:id`,
        summary: `Get single ${primaryPlural.slice(0, -1)} details by ID`,
        authRequired: hasAuth,
        responseSchema: `{ ${primaryPlural.slice(0, -1)}: any }`
      },
      {
        method: 'PUT',
        path: `/api/${primaryPlural}/:id`,
        summary: `Update ${primaryPlural.slice(0, -1)} fields with defensive schema checks`,
        authRequired: hasAuth,
        requestSchema: '{ title?: string; description?: string; status?: string; priority?: string }',
        responseSchema: `{ ${primaryPlural.slice(0, -1)}: any }`
      },
      {
        method: 'DELETE',
        path: `/api/${primaryPlural}/:id`,
        summary: `Delete ${primaryPlural.slice(0, -1)} by ID`,
        authRequired: hasAuth,
        responseSchema: '{ success: boolean }'
      }
    );

    return {
      framework: 'express',
      serverPath: 'server.ts',
      routesPath: 'server/routes/api.ts',
      servicesPath: 'server/services/appService.ts',
      middlewarePath: 'server/middleware/auth.ts',
      endpoints
    };
  }

  private static buildFrontendTopology(
    entities: string[],
    hasAuth: boolean,
    primaryEntity: string,
    primaryPlural: string
  ): ApplicationTopology['frontend'] {
    const components: FrontendComponentDefinition[] = [
      {
        name: 'Button',
        path: 'src/components/ui/Button.tsx',
        role: 'ui_primitive',
        responsibilities: ['Accessible button with variant styles (primary, secondary, danger, ghost)', 'Loading spinner and disabled states']
      },
      {
        name: 'Card',
        path: 'src/components/ui/Card.tsx',
        role: 'ui_primitive',
        responsibilities: ['Structured card layout with header, body, footer, and hover elevation']
      },
      {
        name: 'FormField',
        path: 'src/components/ui/FormField.tsx',
        role: 'ui_primitive',
        responsibilities: ['Input element with label, helper text, and validation error message']
      },
      {
        name: 'Modal',
        path: 'src/components/ui/Modal.tsx',
        role: 'ui_primitive',
        responsibilities: ['Accessible dialog modal with backdrop blur and keyboard escape listener']
      },
      {
        name: 'Navbar',
        path: 'src/components/Navbar.tsx',
        role: 'layout',
        responsibilities: ['Responsive navigation bar with mobile hamburger drawer and user menu'],
        responsiveBreakpoints: ['sm', 'md', 'lg']
      },
      {
        name: `${primaryEntity}ListView`,
        path: `src/components/${primaryEntity}ListView.tsx`,
        role: 'view',
        responsibilities: [`Display list of ${primaryPlural} with search, status filters, and action buttons`, 'Responsive grid on mobile and desktop'],
        responsiveBreakpoints: ['grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-3']
      },
      {
        name: `${primaryEntity}FormModal`,
        path: `src/components/${primaryEntity}FormModal.tsx`,
        role: 'domain_widget',
        responsibilities: [`Form modal to create or update ${primaryEntity} records with input validation`]
      }
    ];

    if (hasAuth) {
      components.push({
        name: 'AuthModal',
        path: 'src/components/AuthModal.tsx',
        role: 'domain_widget',
        responsibilities: ['User login and registration modal with client validation and error banners']
      });
    }

    return {
      framework: 'react',
      clientApiPath: 'src/api/client.ts',
      hooksPath: 'src/hooks/useApi.ts',
      componentsDir: 'src/components',
      viewsDir: 'src/components',
      entryPath: 'src/App.tsx',
      components
    };
  }

  private static buildConnectedFlows(
    entities: string[],
    primaryEntity: string,
    primaryPlural: string,
    hasAuth: boolean,
    mode: ApplicationProjectMode
  ): ConnectedDataFlow[] {
    const flows: ConnectedDataFlow[] = [];

    // Flow 1: Create Entity
    flows.push({
      id: 'flow_create_entity',
      name: `Create ${primaryEntity}`,
      userAction: `User fills ${primaryEntity} form and clicks Submit`,
      frontendHook: `useCreate${primaryEntity}() -> api.create${primaryEntity}(payload)`,
      apiEndpoint: `POST /api/${primaryPlural}`,
      serviceMethod: `AppService.create${primaryEntity}(validatedData)`,
      dbModel: `dbStore.insert${primaryEntity}(record)`,
      migrationVersion: mode === 'modification' ? '002' : '001'
    });

    // Flow 2: Fetch Entity List
    flows.push({
      id: 'flow_fetch_entities',
      name: `Load ${primaryPlural}`,
      userAction: `User navigates to ${primaryPlural} view or updates filters`,
      frontendHook: `use${primaryPlural}(filters) -> api.get${primaryPlural}(filters)`,
      apiEndpoint: `GET /api/${primaryPlural}`,
      serviceMethod: `AppService.list${primaryPlural}(queryOptions)`,
      dbModel: `dbStore.get${primaryPlural}(filters)`,
      migrationVersion: mode === 'modification' ? '002' : '001'
    });

    // Flow 3: Update Entity
    flows.push({
      id: 'flow_update_entity',
      name: `Update ${primaryEntity}`,
      userAction: `User edits status or fields and clicks Save`,
      frontendHook: `useUpdate${primaryEntity}() -> api.update${primaryEntity}(id, patch)`,
      apiEndpoint: `PUT /api/${primaryPlural}/:id`,
      serviceMethod: `AppService.update${primaryEntity}(id, patch)`,
      dbModel: `dbStore.update${primaryEntity}(id, patch)`,
      migrationVersion: mode === 'modification' ? '002' : '001'
    });

    // Flow 4: Delete Entity
    flows.push({
      id: 'flow_delete_entity',
      name: `Delete ${primaryEntity}`,
      userAction: `User clicks Delete and confirms in dialog`,
      frontendHook: `useDelete${primaryEntity}() -> api.delete${primaryEntity}(id)`,
      apiEndpoint: `DELETE /api/${primaryPlural}/:id`,
      serviceMethod: `AppService.delete${primaryEntity}(id)`,
      dbModel: `dbStore.delete${primaryEntity}(id)`,
      migrationVersion: mode === 'modification' ? '002' : '001'
    });

    // Flow 5: Authentication (if enabled)
    if (hasAuth) {
      flows.push({
        id: 'flow_auth_session',
        name: 'User Sign In & Session Establishment',
        userAction: 'User enters email and password in Auth Modal',
        frontendHook: 'useAuth().login(credentials) -> api.login(credentials)',
        apiEndpoint: 'POST /api/auth/login',
        serviceMethod: 'AuthService.authenticateUser(email, password)',
        dbModel: 'dbStore.getUserByEmail(email) -> dbStore.createSession(session)',
        migrationVersion: '001'
      });
    }

    return flows;
  }

  private static buildTieredFilePlan(
    topology: ApplicationTopology,
    mode: ApplicationProjectMode,
    hasAuth: boolean,
    primaryEntity: string,
    primaryPlural: string
  ): PlannedTieredFile[] {
    const files: PlannedTieredFile[] = [];

    // Tier 0: Configuration and root environment
    files.push(
      { path: '.env.example', tier: 0, purpose: 'Environment variable documentation and configuration defaults', role: 'devops_release_specialist' },
      { path: 'package.json', tier: 0, purpose: 'Dependencies, scripts, and runtime engines specification', role: 'devops_release_specialist', isSensitive: true },
      { path: 'tsconfig.json', tier: 0, purpose: 'Strict TypeScript compiler options', role: 'devops_release_specialist' }
    );

    // Tier 1: Shared Domain Types & Contracts
    files.push(
      { path: 'src/types/domain.ts', tier: 1, purpose: 'Domain models, data transfer objects (DTOs), and API response types', role: 'software_architect' }
    );

    // Tier 2: Database Schema, Migrations & Store
    const migrationFile = mode === 'modification'
      ? `${topology.database.migrationsDir}/002_add_${primaryPlural}.ts`
      : `${topology.database.migrationsDir}/001_initial_schema.ts`;

    files.push(
      { path: topology.database.schemaPath, tier: 2, purpose: 'Database table definitions, columns, constraints, and indices', role: 'database_specialist' },
      { path: migrationFile, tier: 2, purpose: 'Versioned schema migration runner with up() and down() steps', role: 'database_specialist' },
      { path: topology.database.migrationRunnerPath, tier: 2, purpose: 'Migration coordinator executing unapplied migrations on startup', role: 'database_specialist' },
      { path: topology.database.storePath, tier: 2, purpose: 'Transactional data access repository with parameterized queries', role: 'database_specialist' }
    );

    // Tier 3: Backend Services, Middleware & API Routes
    if (hasAuth) {
      files.push({
        path: topology.backend.middlewarePath,
        tier: 3,
        purpose: 'Authentication and session verification middleware, password hashing',
        role: 'security_specialist',
        dependsOnFiles: ['src/types/domain.ts', topology.database.storePath]
      });
    }

    files.push(
      {
        path: topology.backend.servicesPath,
        tier: 3,
        purpose: 'Domain business logic and application service operations',
        role: 'backend_developer',
        dependsOnFiles: [topology.database.storePath, 'src/types/domain.ts']
      },
      {
        path: topology.backend.routesPath,
        tier: 3,
        purpose: 'REST API endpoints with defensive schema parsing and error handling',
        role: 'backend_developer',
        dependsOnFiles: [topology.backend.servicesPath, 'src/types/domain.ts']
      },
      {
        path: topology.backend.serverPath,
        tier: 3,
        purpose: 'Express server entry point mounting API router, static middleware, and port listener',
        role: 'software_architect',
        isSensitive: true,
        dependsOnFiles: [topology.backend.routesPath]
      }
    );

    // Tier 4: Client API Client & Data Fetching Hooks
    files.push(
      {
        path: topology.frontend.clientApiPath,
        tier: 4,
        purpose: 'Strongly-typed HTTP fetch client wrapper calling backend API endpoints',
        role: 'frontend_developer',
        dependsOnFiles: ['src/types/domain.ts']
      },
      {
        path: topology.frontend.hooksPath,
        tier: 4,
        purpose: 'Custom React hooks for loading, error state, and async mutations',
        role: 'frontend_developer',
        dependsOnFiles: [topology.frontend.clientApiPath, 'src/types/domain.ts']
      }
    );

    // Tier 5: Reusable Responsive UI Components & Main Views
    for (const comp of topology.frontend.components) {
      files.push({
        path: comp.path,
        tier: 5,
        purpose: comp.responsibilities[0] || `UI component: ${comp.name}`,
        role: 'frontend_developer',
        dependsOnFiles: [topology.frontend.hooksPath, 'src/types/domain.ts']
      });
    }

    files.push({
      path: topology.frontend.entryPath,
      tier: 5,
      purpose: 'Root application layout, state provider, navigation bar, and view router',
      role: 'fullstack_developer',
      dependsOnFiles: topology.frontend.components.map(c => c.path)
    });

    // Tier 6: Automated Integration & Contract Tests
    files.push({
      path: 'tests/connected_application.test.ts',
      tier: 6,
      purpose: 'Automated integration tests asserting full-stack connectivity from DB to API',
      role: 'qa_testing_specialist',
      dependsOnFiles: [
        topology.database.storePath,
        topology.backend.routesPath,
        topology.frontend.clientApiPath
      ]
    });

    return files;
  }

  private static buildCoordinatedTasks(
    plannedFiles: PlannedTieredFile[],
    appName: string,
    primaryEntity: string
  ): FullStackApplicationPlan['tasks'] {
    const tasks: FullStackApplicationPlan['tasks'] = [];

    // Group files by tier to enforce strict dependency chaining
    const tier0Files = plannedFiles.filter(f => f.tier === 0).map(f => f.path);
    const tier1Files = plannedFiles.filter(f => f.tier === 1).map(f => f.path);
    const tier2Files = plannedFiles.filter(f => f.tier === 2).map(f => f.path);
    const tier3Files = plannedFiles.filter(f => f.tier === 3).map(f => f.path);
    const tier4Files = plannedFiles.filter(f => f.tier === 4).map(f => f.path);
    const tier5Files = plannedFiles.filter(f => f.tier === 5).map(f => f.path);
    const tier6Files = plannedFiles.filter(f => f.tier === 6).map(f => f.path);

    // Task 0: Foundation
    tasks.push({
      title: 'Initialize Project Configuration & Environment',
      description: `Establish dependencies, .env.example, and build scripts for ${appName}`,
      filePaths: tier0Files,
      role: 'devops_release_specialist',
      priority: 2,
      dependencies: [],
      tier: 0
    });

    // Task 1: Domain Contracts
    tasks.push({
      title: 'Architect Domain Contracts & API Interfaces',
      description: `Define strict TypeScript types and DTO contracts for ${primaryEntity}`,
      filePaths: tier1Files,
      role: 'software_architect',
      priority: 2,
      dependencies: ['task_tier_0'],
      tier: 1
    });

    // Task 2: Database Schema & Migrations
    tasks.push({
      title: 'Build Database Schema, Migrations & Store Repository',
      description: 'Implement database table schema, versioned migration runner, and data access methods',
      filePaths: tier2Files,
      role: 'database_specialist',
      priority: 2,
      dependencies: ['task_tier_1'],
      tier: 2
    });

    // Task 3: Backend API Routes & Authentication
    tasks.push({
      title: 'Implement Backend Services, Auth Middleware & REST Endpoints',
      description: 'Create Express API route handlers, input validation, and business logic services',
      filePaths: tier3Files,
      role: 'backend_developer',
      priority: 2,
      dependencies: ['task_tier_2'],
      tier: 3
    });

    // Task 4: Client API & Hooks
    tasks.push({
      title: 'Implement Frontend Typed API Client & Data Fetching Hooks',
      description: 'Build client HTTP service wrapper and custom React hooks connecting frontend to REST endpoints',
      filePaths: tier4Files,
      role: 'frontend_developer',
      priority: 3,
      dependencies: ['task_tier_3'],
      tier: 4
    });

    // Task 5: Responsive UI Components & Views
    tasks.push({
      title: 'Build Reusable Responsive UI Components & Interactive Views',
      description: 'Implement accessible Tailwind buttons, cards, forms, modals, and main application layout',
      filePaths: tier5Files,
      role: 'frontend_developer',
      priority: 3,
      dependencies: ['task_tier_4'],
      tier: 5
    });

    // Task 6: Integration Tests
    tasks.push({
      title: 'Automated Full-Stack Integration & End-to-End Test Suite',
      description: 'Verify database persistence, migration execution, and API route contract responses',
      filePaths: tier6Files,
      role: 'qa_testing_specialist',
      priority: 3,
      dependencies: ['task_tier_5'],
      tier: 6
    });

    return tasks;
  }
}
