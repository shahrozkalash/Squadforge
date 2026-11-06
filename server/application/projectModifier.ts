import crypto from 'node:crypto';
import {
  ProjectFile,
  ModelActionResponse,
  FullStackApplicationPlan
} from '../types.js';
import { ConnectedApplicationPlanner } from './connectedPlanner.js';
import { ConnectedApplicationGenerator } from './applicationGenerator.js';

export interface ProjectInspectionResult {
  hasDatabase: boolean;
  hasMigrations: boolean;
  migrationCount: number;
  hasBackendRoutes: boolean;
  hasApiClient: boolean;
  hasTypes: boolean;
  existingTables: string[];
  existingRoutes: string[];
  existingComponents: string[];
}

export class ExistingProjectModifier {
  /**
   * Inspects an existing project codebase to extract current schemas, routes, components, and contracts.
   */
  static inspectProject(files: ProjectFile[]): ProjectInspectionResult {
    const existingTables: string[] = [];
    const existingRoutes: string[] = [];
    const existingComponents: string[] = [];

    let hasDatabase = false;
    let hasMigrations = false;
    let migrationCount = 0;
    let hasBackendRoutes = false;
    let hasApiClient = false;
    let hasTypes = false;

    for (const file of files) {
      const content = file.content || '';

      // Check migrations
      if (file.path.includes('/migrations/')) {
        hasMigrations = true;
        migrationCount++;
      }

      // Check database schema & tables
      if (file.path.includes('schema') || file.path.includes('database') || file.path.includes('store')) {
        hasDatabase = true;
        const tableMatches = content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi);
        if (tableMatches) {
          tableMatches.forEach(m => {
            const name = m.split(/\s+/).pop();
            if (name && !existingTables.includes(name)) existingTables.push(name);
          });
        }
      }

      // Check backend routes
      if (file.path.includes('routes') || file.path.includes('server.ts') || file.path.includes('api')) {
        hasBackendRoutes = true;
        const routeMatches = content.match(/router\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/gi);
        if (routeMatches) {
          routeMatches.forEach(m => {
            const parts = m.match(/['"]([^'"]+)['"]/);
            if (parts && parts[1] && !existingRoutes.includes(parts[1])) {
              existingRoutes.push(parts[1]);
            }
          });
        }
      }

      // Check client API
      if (file.path.includes('api/client') || file.path.includes('hooks/useApi')) {
        hasApiClient = true;
      }

      // Check domain types
      if (file.path.includes('types/domain') || file.path.includes('types/index')) {
        hasTypes = true;
      }

      // Check components
      if (file.path.startsWith('src/components/')) {
        const compName = file.path.split('/').pop()?.replace(/\.(tsx|jsx)$/, '');
        if (compName && !existingComponents.includes(compName)) {
          existingComponents.push(compName);
        }
      }
    }

    return {
      hasDatabase,
      hasMigrations,
      migrationCount,
      hasBackendRoutes,
      hasApiClient,
      hasTypes,
      existingTables,
      existingRoutes,
      existingComponents
    };
  }

  /**
   * Plans and applies non-destructive modifications to an existing project.
   * Generates a new migration version rather than rewriting existing tables,
   * adds new routes without overwriting existing endpoints, and adds new views.
   */
  static planModification(
    buildId: string,
    userRequest: string,
    existingFiles: ProjectFile[]
  ): {
    plan: FullStackApplicationPlan;
    actions: ModelActionResponse['actions'];
    inspection: ProjectInspectionResult;
  } {
    const inspection = this.inspectProject(existingFiles);

    // 1. Plan application in modification mode
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId,
      userRequest,
      existingFiles,
      forceMode: 'modification'
    });

    // 2. Determine next migration version
    const nextMigrationNum = inspection.migrationCount + 1;
    const versionPrefix = String(nextMigrationNum).padStart(3, '0');

    // 3. Generate connected files respecting existing structure
    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, existingFiles);

    // Adjust migration file path if needed
    for (const action of actions) {
      if ('path' in action && typeof action.path === 'string' && action.path.includes('001_initial_schema.ts') && nextMigrationNum > 1) {
        action.path = action.path.replace('001_initial_schema.ts', `${versionPrefix}_update_schema.ts`);
      }
    }

    return {
      plan,
      actions,
      inspection
    };
  }
}
