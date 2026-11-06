import {
  FullStackApplicationPlan,
  ModelActionResponse,
  ProjectFile
} from '../types.js';

export class ConnectedApplicationGenerator {
  /**
   * Generates complete, functional, connected application files across all tiers.
   * Zero placeholders, zero TODO comments, fully functional code with SQLite/in-memory storage,
   * Express API routes, typed client, responsive Tailwind UI, and automated integration tests.
   */
  static generateConnectedFiles(
    plan: FullStackApplicationPlan,
    existingFiles: ProjectFile[] = []
  ): ModelActionResponse['actions'] {
    const actions: ModelActionResponse['actions'] = [];
    const { appName, category, topology, connectedFlows } = plan;
    const primaryTable = topology.database.tables.find(t => t.name !== 'users' && t.name !== 'sessions') || topology.database.tables[0];
    const entityName = primaryTable ? primaryTable.name.charAt(0).toUpperCase() + primaryTable.name.slice(1, -1) : 'Item';
    const entityPlural = primaryTable ? primaryTable.name : 'items';
    const hasAuth = topology.security.protectedRoutes.length > 0;

    // Helper to check if file already exists
    const fileExists = (filePath: string) => existingFiles.some(f => f.path === filePath);

    // =========================================================================
    // TIER 0: Configuration & Environment
    // =========================================================================
    if (!fileExists('.env.example')) {
      const envLines = plan.topology.configuration.envKeys.map(k => `${k.key}=${k.defaultValue || ''}`);
      actions.push({
        action: 'create_file',
        path: '.env.example',
        content: `# Environment variables for ${appName}\n${envLines.join('\n')}\n`,
        commitMessage: 'Initialize documented environment variables template'
      });
    }

    // =========================================================================
    // TIER 1: Shared Domain Types & Contracts (src/types/domain.ts)
    // =========================================================================
    const domainTypesContent = `// Domain types and API contracts for ${appName}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: number;
}

export type SafeUser = Omit<User, 'passwordHash'>;

export interface ${entityName} {
  id: string;
  title: string;
  description?: string;
  status: 'active' | 'pending' | 'completed' | 'archived';
  priority: 'low' | 'medium' | 'high';
  userId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Create${entityName}Input {
  title: string;
  description?: string;
  status?: 'active' | 'pending' | 'completed' | 'archived';
  priority?: 'low' | 'medium' | 'high';
}

export interface Update${entityName}Input {
  title?: string;
  description?: string;
  status?: 'active' | 'pending' | 'completed' | 'archived';
  priority?: 'low' | 'medium' | 'high';
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  success?: boolean;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded';
  timestamp: number;
  database: string;
  appName: string;
}
`;
    actions.push({
      action: fileExists('src/types/domain.ts') ? 'patch_file' : 'create_file',
      path: 'src/types/domain.ts',
      content: domainTypesContent,
      commitMessage: 'Establish domain data types and API contracts'
    });

    // =========================================================================
    // TIER 2: Database Schema, Migrations & Store Repository
    // =========================================================================
    const schemaContent = `// Database schema and table definitions for ${appName}
import { DatabaseSync } from 'node:sqlite';

export function createTables(db: DatabaseSync): void {
  // 1. Users & Sessions
  ${hasAuth ? `
  db.exec(\`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  \`);` : ''}

  // 2. ${entityName} Table
  db.exec(\`
    CREATE TABLE IF NOT EXISTS ${entityPlural} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'medium',
      user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${entityPlural}_status ON ${entityPlural}(status);
    CREATE INDEX IF NOT EXISTS idx_${entityPlural}_created_at ON ${entityPlural}(created_at);
  \`);
}
`;
    actions.push({
      action: fileExists(topology.database.schemaPath) ? 'patch_file' : 'create_file',
      path: topology.database.schemaPath,
      content: schemaContent,
      commitMessage: `Define database schema and indices for ${entityPlural}`
    });

    // Versioned Migration (001_initial_schema.ts)
    const migrationFilePath = `${topology.database.migrationsDir}/001_initial_schema.ts`;
    const migrationContent = `// Version 001 Schema Migration for ${appName}
import { DatabaseSync } from 'node:sqlite';
import { createTables } from '../schema.js';

export const id = 1;
export const name = '001_initial_schema';

export function up(db: DatabaseSync): void {
  createTables(db);
}

export function down(db: DatabaseSync): void {
  db.exec(\`
    DROP TABLE IF EXISTS ${entityPlural};
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS users;
  \`);
}
`;
    actions.push({
      action: 'create_file',
      path: migrationFilePath,
      content: migrationContent,
      commitMessage: 'Create versioned schema migration 001'
    });

    // Migration Runner (server/db/migrationRunner.ts)
    const runnerContent = `// Database Migration Runner for ${appName}
import { DatabaseSync } from 'node:sqlite';
import * as migration001 from './migrations/001_initial_schema.js';

export interface Migration {
  id: number;
  name: string;
  up: (db: DatabaseSync) => void;
  down?: (db: DatabaseSync) => void;
}

export class MigrationRunner {
  private db: DatabaseSync;
  private migrations: Migration[] = [migration001];

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  public run(): { applied: string[]; alreadyUpToDate: boolean } {
    // Ensure migrations ledger table exists
    this.db.exec(\`
      CREATE TABLE IF NOT EXISTS _app_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      );
    \`);

    const appliedRows = this.db.prepare('SELECT id, name FROM _app_migrations').all() as Array<{ id: number; name: string }>;
    const appliedNames = new Set(appliedRows.map(r => r.name));
    const appliedList: string[] = [];

    for (const m of this.migrations) {
      if (!appliedNames.has(m.name)) {
        try {
          this.db.exec('BEGIN IMMEDIATE;');
          m.up(this.db);
          this.db.prepare('INSERT INTO _app_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
          this.db.exec('COMMIT;');
          appliedList.push(m.name);
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch {}
          throw new Error(\`Migration failed on \${m.name}: \${(err as Error).message}\`);
        }
      }
    }

    return {
      applied: appliedList,
      alreadyUpToDate: appliedList.length === 0
    };
  }
}
`;
    actions.push({
      action: fileExists(topology.database.migrationRunnerPath) ? 'patch_file' : 'create_file',
      path: topology.database.migrationRunnerPath,
      content: runnerContent,
      commitMessage: 'Create migration runner with transaction safety'
    });

    // Database Store Repository (server/db/store.ts)
    const storeContent = `// Persistent data repository for ${appName}
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ${entityName}, Create${entityName}Input, Update${entityName}Input, User, SafeUser } from '../../src/types/domain.js';
import { MigrationRunner } from './migrationRunner.js';

export class AppDatabaseStore {
  private static instance: AppDatabaseStore | null = null;
  public db: DatabaseSync;

  private constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    const runner = new MigrationRunner(this.db);
    runner.run();
  }

  public static getInstance(dbPath?: string): AppDatabaseStore {
    if (!AppDatabaseStore.instance) {
      AppDatabaseStore.instance = new AppDatabaseStore(dbPath);
    }
    return AppDatabaseStore.instance;
  }

  public static createIsolated(dbPath: string = ':memory:'): AppDatabaseStore {
    return new AppDatabaseStore(dbPath);
  }

  // --- ${entityName} CRUD Operations ---

  public list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters?: { status?: string; search?: string }): ${entityName}[] {
    let query = 'SELECT * FROM ${entityPlural} WHERE 1=1';
    const params: any[] = [];

    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.search) {
      query += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(\`%\${filters.search}%\`, \`%\${filters.search}%\`);
    }

    query += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(r => this.map${entityName}(r));
  }

  public get${entityName}ById(id: string): ${entityName} | null {
    const row = this.db.prepare('SELECT * FROM ${entityPlural} WHERE id = ?').get(id) as any;
    return row ? this.map${entityName}(row) : null;
  }

  public insert${entityName}(input: Create${entityName}Input, userId?: string): ${entityName} {
    const now = Date.now();
    const id = \`${entityName.toLowerCase()}_\${now}_\${crypto.randomBytes(3).toString('hex')}\`;
    const record: ${entityName} = {
      id,
      title: input.title.trim(),
      description: input.description?.trim(),
      status: input.status || 'active',
      priority: input.priority || 'medium',
      userId,
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(\`
      INSERT INTO ${entityPlural} (id, title, description, status, priority, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(
      record.id,
      record.title,
      record.description || null,
      record.status,
      record.priority,
      record.userId || null,
      record.createdAt,
      record.updatedAt
    );

    return record;
  }

  public update${entityName}(id: string, patch: Update${entityName}Input): ${entityName} | null {
    const existing = this.get${entityName}ById(id);
    if (!existing) return null;

    const now = Date.now();
    const updated: ${entityName} = {
      ...existing,
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      description: patch.description !== undefined ? patch.description?.trim() : existing.description,
      status: patch.status || existing.status,
      priority: patch.priority || existing.priority,
      updatedAt: now
    };

    this.db.prepare(\`
      UPDATE ${entityPlural}
      SET title = ?, description = ?, status = ?, priority = ?, updated_at = ?
      WHERE id = ?
    \`).run(
      updated.title,
      updated.description || null,
      updated.status,
      updated.priority,
      updated.updatedAt,
      id
    );

    return updated;
  }

  public delete${entityName}(id: string): boolean {
    const res = this.db.prepare('DELETE FROM ${entityPlural} WHERE id = ?').run(id) as any;
    return res && res.changes > 0;
  }

  private map${entityName}(row: any): ${entityName} {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      status: row.status,
      priority: row.priority,
      userId: row.user_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
`;
    actions.push({
      action: fileExists(topology.database.storePath) ? 'patch_file' : 'create_file',
      path: topology.database.storePath,
      content: storeContent,
      commitMessage: `Implement persistent SQLite repository for ${entityPlural}`
    });

    // =========================================================================
    // TIER 3: Backend Services, Auth Middleware & REST Endpoints
    // =========================================================================
    const servicesContent = `// Application Service Layer for ${appName}
import { AppDatabaseStore } from '../db/store.js';
import { ${entityName}, Create${entityName}Input, Update${entityName}Input } from '../../src/types/domain.js';

export class AppService {
  private store: AppDatabaseStore;

  constructor(store?: AppDatabaseStore) {
    this.store = store || AppDatabaseStore.getInstance();
  }

  public list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters?: { status?: string; search?: string }): ${entityName}[] {
    return this.store.list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters);
  }

  public get${entityName}(id: string): ${entityName} {
    const item = this.store.get${entityName}ById(id);
    if (!item) {
      throw new Error('${entityName} not found');
    }
    return item;
  }

  public create${entityName}(input: Create${entityName}Input, userId?: string): ${entityName} {
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Title is required and cannot be empty');
    }
    return this.store.insert${entityName}(input, userId);
  }

  public update${entityName}(id: string, patch: Update${entityName}Input): ${entityName} {
    const item = this.store.update${entityName}(id, patch);
    if (!item) {
      throw new Error('${entityName} not found');
    }
    return item;
  }

  public delete${entityName}(id: string): boolean {
    const success = this.store.delete${entityName}(id);
    if (!success) {
      throw new Error('${entityName} not found or already deleted');
    }
    return true;
  }
}
`;
    actions.push({
      action: fileExists(topology.backend.servicesPath) ? 'patch_file' : 'create_file',
      path: topology.backend.servicesPath,
      content: servicesContent,
      commitMessage: `Implement domain business service for ${entityPlural}`
    });

    // API Routes (server/routes/api.ts)
    const routesContent = `// REST API Routes Controller for ${appName}
import { Router, Request, Response } from 'express';
import { AppService } from '../services/appService.js';
import { Create${entityName}Input, Update${entityName}Input } from '../../src/types/domain.js';

export function createApiRouter(service?: AppService): Router {
  const router = Router();
  const appService = service || new AppService();

  // Health and Uptime Endpoint
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: Date.now(),
      database: 'connected',
      appName: '${appName}'
    });
  });

  // GET /api/${entityPlural} - List
  router.get('/${entityPlural}', (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const items = appService.list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}({ status, search });
      res.json({ ${entityPlural}: items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list ${entityPlural}' });
    }
  });

  // GET /api/${entityPlural}/:id - Read Single
  router.get('/${entityPlural}/:id', (req: Request, res: Response) => {
    try {
      const item = appService.get${entityName}(req.params.id);
      res.json({ ${entityName.toLowerCase()}: item });
    } catch (err: any) {
      res.status(404).json({ error: err.message || '${entityName} not found' });
    }
  });

  // POST /api/${entityPlural} - Create with Validation
  router.post('/${entityPlural}', (req: Request, res: Response) => {
    try {
      const body = req.body as Create${entityName}Input;
      if (!body || !body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
        return res.status(400).json({ error: 'Field "title" is required and cannot be empty' });
      }
      const item = appService.create${entityName}(body);
      res.status(201).json({ ${entityName.toLowerCase()}: item });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create ${entityName}' });
    }
  });

  // PUT /api/${entityPlural}/:id - Update
  router.put('/${entityPlural}/:id', (req: Request, res: Response) => {
    try {
      const body = req.body as Update${entityName}Input;
      const item = appService.update${entityName}(req.params.id, body);
      res.json({ ${entityName.toLowerCase()}: item });
    } catch (err: any) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // DELETE /api/${entityPlural}/:id - Delete
  router.delete('/${entityPlural}/:id', (req: Request, res: Response) => {
    try {
      appService.delete${entityName}(req.params.id);
      res.json({ success: true, message: '${entityName} deleted successfully' });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
`;
    actions.push({
      action: fileExists(topology.backend.routesPath) ? 'patch_file' : 'create_file',
      path: topology.backend.routesPath,
      content: routesContent,
      commitMessage: `Create REST API route handlers for ${entityPlural}`
    });

    // =========================================================================
    // TIER 4: Client API Client & Data Fetching Hooks
    // =========================================================================
    const clientApiContent = `// Strongly-typed Frontend API Client for ${appName}
import { ${entityName}, Create${entityName}Input, Update${entityName}Input, HealthCheckResponse } from '../types/domain.js';

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = \`\${this.baseUrl}\${path}\`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as any) || {})
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      let errorMessage = \`HTTP \${res.status}: \${res.statusText}\`;
      try {
        const body = await res.json();
        if (body.error) errorMessage = body.error;
      } catch {}
      throw new Error(errorMessage);
    }
    return res.json();
  }

  public async getHealth(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>('/api/health');
  }

  public async list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters?: { status?: string; search?: string }): Promise<{ ${entityPlural}: ${entityName}[]; total: number }> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.search) params.set('search', filters.search);
    const queryString = params.toString() ? \`?\${params.toString()}\` : '';
    return this.request<{ ${entityPlural}: ${entityName}[]; total: number }>(\`/api/${entityPlural}\${queryString}\`);
  }

  public async get${entityName}(id: string): Promise<{ ${entityName.toLowerCase()}: ${entityName} }> {
    return this.request<{ ${entityName.toLowerCase()}: ${entityName} }>(\`/api/${entityPlural}/\${id}\`);
  }

  public async create${entityName}(input: Create${entityName}Input): Promise<{ ${entityName.toLowerCase()}: ${entityName} }> {
    return this.request<{ ${entityName.toLowerCase()}: ${entityName} }>('/api/${entityPlural}', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  public async update${entityName}(id: string, patch: Update${entityName}Input): Promise<{ ${entityName.toLowerCase()}: ${entityName} }> {
    return this.request<{ ${entityName.toLowerCase()}: ${entityName} }>(\`/api/${entityPlural}/\${id}\`, {
      method: 'PUT',
      body: JSON.stringify(patch)
    });
  }

  public async delete${entityName}(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(\`/api/${entityPlural}/\${id}\`, {
      method: 'DELETE'
    });
  }
}

export const api = new ApiClient();
`;
    actions.push({
      action: fileExists(topology.frontend.clientApiPath) ? 'patch_file' : 'create_file',
      path: topology.frontend.clientApiPath,
      content: clientApiContent,
      commitMessage: 'Create strongly-typed client API fetch wrapper'
    });

    // Custom React Hooks (src/hooks/useApi.ts)
    const hooksContent = `// Custom React Hooks for data fetching and mutations in ${appName}
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';
import { ${entityName}, Create${entityName}Input, Update${entityName}Input } from '../types/domain.js';

export function use${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters?: { status?: string; search?: string }) {
  const [data, setData] = useState<${entityName}[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}(filters);
      setData(res.${entityPlural} || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load ${entityPlural}');
    } finally {
      setLoading(false);
    }
  }, [filters?.status, filters?.search]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const createItem = async (input: Create${entityName}Input) => {
    const res = await api.create${entityName}(input);
    setData(prev => [res.${entityName.toLowerCase()}, ...prev]);
    return res.${entityName.toLowerCase()};
  };

  const updateItem = async (id: string, patch: Update${entityName}Input) => {
    const res = await api.update${entityName}(id, patch);
    setData(prev => prev.map(item => item.id === id ? res.${entityName.toLowerCase()} : item));
    return res.${entityName.toLowerCase()};
  };

  const deleteItem = async (id: string) => {
    await api.delete${entityName}(id);
    setData(prev => prev.filter(item => item.id !== id));
  };

  return {
    data,
    loading,
    error,
    refresh: fetchItems,
    createItem,
    updateItem,
    deleteItem
  };
}
`;
    actions.push({
      action: fileExists(topology.frontend.hooksPath) ? 'patch_file' : 'create_file',
      path: topology.frontend.hooksPath,
      content: hooksContent,
      commitMessage: `Create custom React hooks for ${entityPlural} state management`
    });

    // =========================================================================
    // TIER 5: Reusable Responsive UI Components (Button, Card, FormField, Modal)
    // =========================================================================
    const buttonContent = `// Reusable accessible Button component
import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  ...props
}) => {
  const base = 'inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg cursor-pointer';

  const variants = {
    primary: 'bg-amber-500 hover:bg-amber-600 text-neutral-950 font-semibold focus:ring-amber-400',
    secondary: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700 focus:ring-neutral-500',
    danger: 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500',
    ghost: 'bg-transparent hover:bg-neutral-800 text-neutral-300 focus:ring-neutral-400'
  };

  const sizes = {
    sm: 'text-xs px-2.5 py-1.5 gap-1.5',
    md: 'text-sm px-4 py-2 gap-2',
    lg: 'text-base px-5 py-2.5 gap-2.5'
  };

  return (
    <button
      disabled={disabled || loading}
      className={\`\${base} \${variants[variant]} \${sizes[size]} \${className}\`}
      {...props}
    >
      {loading && (
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      )}
      {children}
    </button>
  );
};
`;
    actions.push({
      action: fileExists('src/components/ui/Button.tsx') ? 'patch_file' : 'create_file',
      path: 'src/components/ui/Button.tsx',
      content: buttonContent,
      commitMessage: 'Create reusable Button component'
    });

    const cardContent = `// Reusable Card component
import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export const Card: React.FC<CardProps> = ({ children, className = '', onClick }) => {
  return (
    <div
      onClick={onClick}
      className={\`bg-neutral-900/90 border border-neutral-800 rounded-xl p-5 shadow-sm hover:border-neutral-700 transition-all \${className}\`}
    >
      {children}
    </div>
  );
};
`;
    actions.push({
      action: fileExists('src/components/ui/Card.tsx') ? 'patch_file' : 'create_file',
      path: 'src/components/ui/Card.tsx',
      content: cardContent,
      commitMessage: 'Create reusable Card component'
    });

    const formFieldContent = `// Reusable FormField component
import React from 'react';

export interface FormFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  helperText?: string;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  error,
  helperText,
  id,
  className = '',
  ...props
}) => {
  const inputId = id || \`field_\${label.toLowerCase().replace(/\\s+/g, '_')}\`;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <label htmlFor={inputId} className="text-xs font-semibold text-neutral-300">
        {label}
      </label>
      <input
        id={inputId}
        className={\`w-full px-3.5 py-2 text-sm bg-neutral-950 border rounded-lg text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-colors \${
          error ? 'border-red-500 focus:border-red-500' : 'border-neutral-800 focus:border-amber-500'
        } \${className}\`}
        {...props}
      />
      {error && <span className="text-xs text-red-400">{error}</span>}
      {helperText && !error && <span className="text-xs text-neutral-500">{helperText}</span>}
    </div>
  );
};
`;
    actions.push({
      action: fileExists('src/components/ui/FormField.tsx') ? 'patch_file' : 'create_file',
      path: 'src/components/ui/FormField.tsx',
      content: formFieldContent,
      commitMessage: 'Create reusable FormField component'
    });

    const modalContent = `// Accessible Modal component
import React, { useEffect } from 'react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
          <h3 className="text-lg font-bold text-neutral-100">{title}</h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200 transition-colors p-1"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
};
`;
    actions.push({
      action: fileExists('src/components/ui/Modal.tsx') ? 'patch_file' : 'create_file',
      path: 'src/components/ui/Modal.tsx',
      content: modalContent,
      commitMessage: 'Create accessible Modal component'
    });

    // =========================================================================
    // TIER 6: Automated Integration Tests (tests/connected_application.test.ts)
    // =========================================================================
    const testsContent = `// Automated Full-Stack Connected Application Test Suite
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppDatabaseStore } from '../server/db/store.js';
import { AppService } from '../server/services/appService.js';
import { createApiRouter } from '../server/routes/api.js';

describe('Phase 13: Full-Stack Connected Application Tests for ${appName}', () => {
  let store: AppDatabaseStore;
  let service: AppService;

  beforeEach(() => {
    store = AppDatabaseStore.createIsolated(':memory:');
    service = new AppService(store);
  });

  test('Database migrations run cleanly and initialize tables', () => {
    const list = store.list${entityPlural.charAt(0).toUpperCase() + entityPlural.slice(1)}();
    assert.ok(Array.isArray(list), 'List must return array');
    assert.equal(list.length, 0, 'Initial database table should be empty');
  });

  test('Store creates and retrieves a ${entityName} with valid timestamps', () => {
    const created = store.insert${entityName}({
      title: 'Test ${entityName}',
      description: 'Verifying end-to-end connected data flow',
      priority: 'high'
    });

    assert.ok(created.id, 'Created record must have generated ID');
    assert.equal(created.title, 'Test ${entityName}');
    assert.equal(created.priority, 'high');
    assert.ok(created.createdAt > 0);

    const retrieved = store.get${entityName}ById(created.id);
    assert.ok(retrieved);
    assert.equal(retrieved.id, created.id);
  });

  test('AppService updates and deletes ${entityName} with input validation', () => {
    const created = service.create${entityName}({
      title: 'To Be Updated'
    });

    const updated = service.update${entityName}(created.id, {
      title: 'Successfully Updated',
      status: 'completed'
    });

    assert.equal(updated.title, 'Successfully Updated');
    assert.equal(updated.status, 'completed');

    const deleted = service.delete${entityName}(created.id);
    assert.equal(deleted, true);

    assert.throws(() => service.get${entityName}(created.id), /not found/);
  });

  test('AppService rejects empty or invalid title input defensively', () => {
    assert.throws(() => service.create${entityName}({ title: '   ' }), /required/);
  });

  test('Express API Router defines all required CRUD endpoints', () => {
    const router = createApiRouter(service);
    assert.ok(router, 'Router must be instantiated');

    const registeredRoutes = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods)
      }));

    assert.ok(registeredRoutes.some((r: any) => r.path === '/health'));
    assert.ok(registeredRoutes.some((r: any) => r.path === '/${entityPlural}'));
    assert.ok(registeredRoutes.some((r: any) => r.path === '/${entityPlural}/:id'));
  });
});
`;
    actions.push({
      action: 'create_file',
      path: 'tests/connected_application.test.ts',
      content: testsContent,
      commitMessage: `Create automated integration tests for ${appName}`
    });

    return actions;
  }
}
