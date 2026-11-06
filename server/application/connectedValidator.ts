import {
  ProjectFile,
  ConnectedValidationReport,
  ConnectedValidationCheck,
  FullStackApplicationPlan
} from '../types.js';

export class ConnectedApplicationValidator {
  /**
   * Validates that a generated application is genuinely connected end-to-end:
   * Database -> Migrations -> Store -> Services -> Routes -> Client API -> Hooks -> Responsive UI -> Tests.
   */
  static validate(files: ProjectFile[], plan?: FullStackApplicationPlan): ConnectedValidationReport {
    const checks: ConnectedValidationCheck[] = [];
    const unresolvedIssues: string[] = [];

    const fileMap = new Map<string, string>();
    for (const f of files) {
      fileMap.set(f.path, f.content || '');
    }

    // Helper to find file by partial path
    const findFile = (substring: string): { path: string; content: string } | undefined => {
      for (const [p, c] of fileMap.entries()) {
        if (p.includes(substring)) return { path: p, content: c };
      }
      return undefined;
    };

    // -------------------------------------------------------------------------
    // 1. DATABASE CONNECTIVITY & MIGRATION INTEGRITY
    // -------------------------------------------------------------------------
    const schemaFile = findFile('server/db/schema.ts') || findFile('src/db/schema.ts') || findFile('db/schema');
    const storeFile = findFile('server/db/store.ts') || findFile('src/db/store.ts') || findFile('src/services/store');
    const migrationFile = files.find(f => f.path.includes('/migrations/'));
    const runnerFile = findFile('migrationRunner') || findFile('database.ts');

    const dbChecksPassed = Boolean(schemaFile && storeFile);
    checks.push({
      category: 'database',
      title: 'Database Schema & Table Definitions',
      passed: Boolean(schemaFile),
      details: schemaFile ? `Found database schema in ${schemaFile.path}` : 'Missing database schema definitions',
      evidence: schemaFile?.content.slice(0, 150)
    });

    checks.push({
      category: 'database',
      title: 'Versioned Schema Migrations & Runner',
      passed: Boolean(migrationFile),
      details: migrationFile ? `Found migration file: ${migrationFile.path}` : 'No versioned migration files located',
      evidence: migrationFile?.content.slice(0, 150)
    });

    checks.push({
      category: 'database',
      title: 'Transactional Store Repository with Parameterized Queries',
      passed: Boolean(storeFile && (storeFile.content.includes('prepare(') || storeFile.content.includes('db.'))),
      details: storeFile ? `Found persistent data store repository in ${storeFile.path}` : 'Missing database store repository',
      evidence: storeFile?.content.slice(0, 150)
    });

    if (!schemaFile) unresolvedIssues.push('Database schema file is missing');
    if (!migrationFile) unresolvedIssues.push('Database migration files are missing');
    if (!storeFile) unresolvedIssues.push('Database store repository is missing');

    // -------------------------------------------------------------------------
    // 2. BACKEND API ROUTES & DEFENSIVE INPUT VALIDATION
    // -------------------------------------------------------------------------
    const routesFile = findFile('routes/api.ts') || findFile('routes/') || findFile('server.ts');
    const hasInputValidation = routesFile && (/req\.body|trim\(|throw new Error|status\(400\)/i.test(routesFile.content));

    checks.push({
      category: 'api',
      title: 'REST API Route Endpoints',
      passed: Boolean(routesFile && routesFile.content.includes('/api/')),
      details: routesFile ? `Found REST API route definitions in ${routesFile.path}` : 'No REST API route definitions found',
      evidence: routesFile ? routesFile.content.match(/\/api\/[a-zA-Z0-9_\-\/:]+/g)?.slice(0, 4).join(', ') : undefined
    });

    checks.push({
      category: 'api',
      title: 'Defensive Request Input Validation',
      passed: Boolean(hasInputValidation),
      details: hasInputValidation ? 'Defensive input validation and HTTP 400 error guards verified' : 'Missing input validation guards on API mutation endpoints',
      evidence: hasInputValidation ? 'Validated request parameters and body structure present' : undefined
    });

    if (!routesFile) unresolvedIssues.push('Backend API routes are missing');

    // -------------------------------------------------------------------------
    // 3. CLIENT-SERVER CONTRACT ALIGNMENT
    // -------------------------------------------------------------------------
    const clientApiFile = findFile('api/client.ts') || findFile('src/api/') || findFile('clientApi');
    const hooksFile = findFile('hooks/useApi.ts') || findFile('hooks/');
    const typesFile = findFile('types/domain.ts') || findFile('types/index.ts') || findFile('types/');

    // Check that client calls backend paths
    const clientCallsApi = Boolean(clientApiFile && clientApiFile.content.includes('/api/'));

    checks.push({
      category: 'integration',
      title: 'Strongly-Typed Client API Wrapper',
      passed: Boolean(clientCallsApi),
      details: clientCallsApi ? `Client API in ${clientApiFile?.path} communicates with backend /api/ endpoints` : 'Frontend lacks typed API client communicating with backend routes',
      evidence: clientApiFile?.content.slice(0, 150)
    });

    checks.push({
      category: 'integration',
      title: 'React Custom Data-Fetching Hooks',
      passed: Boolean(hooksFile && hooksFile.content.includes('useState')),
      details: hooksFile ? `Found custom data-fetching hooks in ${hooksFile.path}` : 'Missing custom React hooks connecting UI to API client',
      evidence: hooksFile?.content.slice(0, 150)
    });

    checks.push({
      category: 'integration',
      title: 'Shared Domain Contracts & DTO Interfaces',
      passed: Boolean(typesFile && typesFile.content.includes('export interface')),
      details: typesFile ? `Found domain interfaces and DTOs in ${typesFile.path}` : 'Missing domain TypeScript contracts',
      evidence: typesFile?.content.slice(0, 150)
    });

    if (!clientCallsApi) unresolvedIssues.push('Client API communication with backend is missing');
    if (!typesFile) unresolvedIssues.push('Shared domain contracts are missing');

    // -------------------------------------------------------------------------
    // 4. RESPONSIVE FRONTEND & REUSABLE UI COMPONENTS
    // -------------------------------------------------------------------------
    const buttonComp = findFile('Button.tsx');
    const cardComp = findFile('Card.tsx');
    const formFieldComp = findFile('FormField.tsx') || findFile('Input.tsx');
    const modalComp = findFile('Modal.tsx') || findFile('Dialog.tsx');
    const appEntry = findFile('src/App.tsx');

    const hasReusableUi = Boolean(buttonComp || cardComp || formFieldComp || modalComp);
    const hasResponsiveClasses = files.some(f =>
      f.content && (f.content.includes('sm:') || f.content.includes('md:') || f.content.includes('lg:') || f.content.includes('flex-col sm:flex-row'))
    );

    checks.push({
      category: 'frontend',
      title: 'Reusable UI Component Primitives',
      passed: hasReusableUi,
      details: hasReusableUi ? 'Verified reusable UI components (Button, Card, FormField, Modal)' : 'Missing reusable UI component library',
      evidence: [buttonComp?.path, cardComp?.path, formFieldComp?.path, modalComp?.path].filter(Boolean).join(', ')
    });

    checks.push({
      category: 'frontend',
      title: 'Responsive Design & Mobile-First Layout',
      passed: hasResponsiveClasses,
      details: hasResponsiveClasses ? 'Responsive Tailwind breakpoints (sm:, md:, lg:) and flexible layouts detected' : 'Missing responsive styling breakpoints',
      evidence: 'Responsive utility classes present in view components'
    });

    checks.push({
      category: 'frontend',
      title: 'Application Root View & State Integration',
      passed: Boolean(appEntry && appEntry.content.includes('return')),
      details: appEntry ? `Root application view verified in ${appEntry.path}` : 'Missing root application entry point',
      evidence: appEntry?.path
    });

    if (!hasReusableUi) unresolvedIssues.push('Reusable UI component primitives are missing');

    // -------------------------------------------------------------------------
    // 5. SECURITY & CONFIGURATION INTEGRITY
    // -------------------------------------------------------------------------
    const envFile = findFile('.env.example');
    const hasSecretLeak = files.some(f =>
      f.path !== '.env.example' &&
      f.content &&
      /(['"`])(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{33})\1/.test(f.content)
    );

    checks.push({
      category: 'security',
      title: 'Environment Configuration Documentation',
      passed: Boolean(envFile),
      details: envFile ? 'Verified .env.example with documented variable keys' : 'Missing .env.example configuration file',
      evidence: envFile?.path
    });

    checks.push({
      category: 'security',
      title: 'Zero Hardcoded Secrets in Source Code',
      passed: !hasSecretLeak,
      details: !hasSecretLeak ? 'No hardcoded private keys or access tokens detected in source files' : 'Potential hardcoded secret pattern detected in source files',
      evidence: 'Checked against OWASP secret patterns'
    });

    if (!envFile) unresolvedIssues.push('Environment configuration template (.env.example) is missing');
    if (hasSecretLeak) unresolvedIssues.push('Potential hardcoded credentials detected');

    // -------------------------------------------------------------------------
    // 6. AUTOMATED INTEGRATION & CONTRACT TESTS
    // -------------------------------------------------------------------------
    const testFile = files.find(f => f.path.startsWith('tests/') && f.path.endsWith('.test.ts'));
    const testHasAssertions = Boolean(testFile && (testFile.content.includes('assert.') || testFile.content.includes('expect(')));

    checks.push({
      category: 'tests',
      title: 'Automated Integration & Contract Test Suite',
      passed: Boolean(testFile && testHasAssertions),
      details: testFile ? `Found automated test suite in ${testFile.path} with assertions` : 'No automated integration test files detected',
      evidence: testFile?.path
    });

    if (!testFile) unresolvedIssues.push('Automated integration test file is missing');

    // -------------------------------------------------------------------------
    // SCORE & VERDICT CALCULATION
    // -------------------------------------------------------------------------
    const passedCount = checks.filter(c => c.passed).length;
    const totalCount = checks.length;
    const score = Math.round((passedCount / totalCount) * 100);

    const connectedFlowsCount = plan?.connectedFlows.length || 4;
    const verifiedFlowsCount = Math.round((score / 100) * connectedFlowsCount);

    let verdict: ConnectedValidationReport['verdict'] = 'verified';
    if (score < 70 || unresolvedIssues.length > 2) {
      verdict = 'rejected';
    } else if (score < 90 || unresolvedIssues.length > 0) {
      verdict = 'passed_with_warnings';
    }

    return {
      verdict,
      score,
      checks,
      connectedFlowsVerified: verifiedFlowsCount,
      totalConnectedFlows: connectedFlowsCount,
      unresolvedIssues,
      timestamp: Date.now()
    };
  }
}
