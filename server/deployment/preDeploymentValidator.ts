/**
 * SquadForge Phase 15: Pre-Deployment Project Validator
 * Evaluates production readiness using truthful evidence before allowing deployment.
 */

import { db } from '../store.js';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';
import { PreDeploymentValidationResult, PreDeploymentValidationCheck } from './types.js';

const SYSTEM_ENV_VARS = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'PUBLIC_URL',
  'CI'
]);

export class PreDeploymentValidator {
  /**
   * Performs rigorous pre-deployment verification across structure, syntax, security, and secrets.
   */
  static validateProject(buildId: string): PreDeploymentValidationResult {
    const build = db.getBuild(buildId);
    if (!build) {
      throw new Error(`Project build "${buildId}" not found.`);
    }

    const files = db.getAllFiles(buildId);
    const checks: PreDeploymentValidationCheck[] = [];
    const defects: string[] = [];
    const missingSecrets: string[] = [];
    const recommendedActions: string[] = [];

    // 1. Structure Check: Files exist
    const hasFiles = files.length > 0;
    checks.push({
      category: 'files',
      name: 'Project Workspace Files',
      status: hasFiles ? 'passed' : 'failed',
      passed: hasFiles,
      message: hasFiles ? `${files.length} project file(s) present.` : 'No files found in workspace.'
    });
    if (!hasFiles) {
      defects.push('No files exist in the project workspace.');
    }

    // 2. Entry Point Check
    const entryPoints = [
      'index.html',
      'src/main.tsx',
      'src/main.ts',
      'src/main.jsx',
      'src/main.js',
      'src/index.tsx',
      'src/index.ts',
      'src/App.tsx',
      'server.ts',
      'server.js',
      'index.js',
      'app.js'
    ];
    const hasEntryPoint = files.some(f => entryPoints.includes(f.path.toLowerCase()));
    checks.push({
      category: 'files',
      name: 'Web Application Entry Point',
      status: hasEntryPoint ? 'passed' : 'failed',
      passed: hasEntryPoint,
      message: hasEntryPoint 
        ? 'Application entry point detected.' 
        : 'Missing standard web entry point (index.html, src/main.tsx, or server entry).'
    });
    if (!hasEntryPoint) {
      defects.push('Application lacks a recognized web entry point (e.g. index.html or src/main.tsx).');
      recommendedActions.push('Create an index.html or src/main.tsx entry point for web deployment.');
    }

    // 3. Package Configuration Check
    const pkgFile = files.find(f => f.path.toLowerCase() === 'package.json');
    let pkgJson: any = null;
    if (pkgFile) {
      try {
        pkgJson = JSON.parse(pkgFile.content);
        checks.push({
          category: 'config',
          name: 'Package Configuration (package.json)',
          status: 'passed',
          passed: true,
          message: `Valid package.json configuration found (${pkgJson.name || 'unnamed'}).`
        });
      } catch (err: any) {
        checks.push({
          category: 'config',
          name: 'Package Configuration (package.json)',
          status: 'failed',
          passed: false,
          message: `Malformed package.json: ${err.message}`
        });
        defects.push('package.json contains invalid JSON syntax.');
      }
    } else {
      // Pure HTML/static sites may not have package.json, which is permissible for static host
      const isStaticSite = files.some(f => f.path.toLowerCase() === 'index.html');
      checks.push({
        category: 'config',
        name: 'Package Configuration',
        status: isStaticSite ? 'passed' : 'warning',
        passed: isStaticSite,
        message: isStaticSite 
          ? 'Static HTML site detected (no package.json needed).' 
          : 'package.json not found in project.'
      });
    }

    // 4. Execution Adapter Verification (Syntax & Security AST)
    const execResult = ExecutionAdapter.runCompleteVerification(buildId, files);

    // Syntax validation check
    const syntaxPassed = execResult.syntaxErrors.length === 0;
    checks.push({
      category: 'syntax',
      name: 'Code Syntax & AST Integrity',
      status: syntaxPassed ? 'passed' : 'failed',
      passed: syntaxPassed,
      message: syntaxPassed 
        ? 'All source files passed syntax and language checks without error.'
        : `${execResult.syntaxErrors.length} syntax error(s) detected.`
    });
    if (!syntaxPassed) {
      for (const err of execResult.syntaxErrors.slice(0, 5)) {
        defects.push(`Syntax error in ${err.filePath}: ${err.message}`);
      }
      recommendedActions.push('Fix syntax errors before submitting project for production deployment.');
    }

    // Security Audit Check
    const securityFindings = [...execResult.securityAudit.findings];

    for (const f of files) {
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(f.content)) {
        securityFindings.push({
          severity: 'high',
          filePath: f.path,
          message: 'Hardcoded private cryptographic key detected.'
        });
      }
    }

    const criticalSecurity = securityFindings.filter(f => f.severity === 'high');
    const securityPassed = criticalSecurity.length === 0;
    checks.push({
      category: 'security',
      name: 'Security & Secret Leak Scan',
      status: securityPassed ? 'passed' : 'failed',
      passed: securityPassed,
      message: securityPassed 
        ? 'No leaked credentials, private keys, or high-risk security flaws detected.'
        : `${criticalSecurity.length} critical security finding(s) detected.`
    });
    if (!securityPassed) {
      for (const finding of criticalSecurity) {
        defects.push(`Security flaw in ${finding.filePath}: ${finding.message}`);
      }
      recommendedActions.push('Remove hardcoded secrets and credentials from code and use deployment secrets.');
    }

    // 5. Referenced Environment Variables Check
    const referencedVars = new Set<string>();
    const envRegex = /(?:process\.env\.([A-Z0-9_]+)|import\.meta\.env\.(VITE_[A-Z0-9_]+))/g;

    for (const file of files) {
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path)) {
        let match;
        while ((match = envRegex.exec(file.content)) !== null) {
          const varName = match[1] || match[2];
          if (varName && !SYSTEM_ENV_VARS.has(varName)) {
            referencedVars.add(varName);
          }
        }
      }
    }

    const configuredSecrets = new Set(
      db.getDeploymentSecrets(buildId).map(s => s.key)
    );

    for (const refVar of referencedVars) {
      if (!configuredSecrets.has(refVar)) {
        missingSecrets.push(refVar);
      }
    }

    if (missingSecrets.length > 0) {
      checks.push({
        category: 'secrets',
        name: 'Environment Secrets Coverage',
        status: 'warning',
        passed: true,
        message: `${missingSecrets.length} referenced environment variable(s) not yet configured: ${missingSecrets.join(', ')}.`
      });
      recommendedActions.push(`Configure values for referenced secrets: ${missingSecrets.join(', ')}.`);
    } else {
      checks.push({
        category: 'secrets',
        name: 'Environment Secrets Coverage',
        status: 'passed',
        passed: true,
        message: 'All referenced environment variables have configured deployment secrets.'
      });
    }

    // Compute Truthful Readiness Score (0-100)
    let score = 100;
    if (!hasFiles) score -= 50;
    if (!hasEntryPoint) score -= 30;
    if (!syntaxPassed) score -= 40;
    if (!securityPassed) score -= 40;
    if (missingSecrets.length > 0) score -= Math.min(20, missingSecrets.length * 5);

    const readinessScore = Math.max(0, Math.min(100, score));
    const passed = hasFiles && hasEntryPoint && syntaxPassed && securityPassed;

    return {
      passed,
      readinessScore,
      checks,
      defects,
      missingSecrets,
      recommendedActions
    };
  }
}
