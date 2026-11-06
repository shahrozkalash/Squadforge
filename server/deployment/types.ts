/**
 * SquadForge Phase 15: Deployment & Distribution Types & Interfaces
 */

import {
  DeploymentProviderType,
  DeploymentEnvironment,
  DeploymentStatus,
  DeploymentRecord,
  DeploymentSecretRecord,
  SafeDeploymentSecret,
  DeploymentLogEntry
} from '../types.js';

export type {
  DeploymentProviderType,
  DeploymentEnvironment,
  DeploymentStatus,
  DeploymentRecord,
  DeploymentSecretRecord,
  SafeDeploymentSecret,
  DeploymentLogEntry
};

export interface PreDeploymentValidationCheck {
  category: 'files' | 'syntax' | 'security' | 'config' | 'secrets';
  name: string;
  status: 'passed' | 'warning' | 'failed';
  passed: boolean;
  message: string;
}

export interface PreDeploymentValidationResult {
  passed: boolean;
  readinessScore: number; // 0 - 100
  checks: PreDeploymentValidationCheck[];
  defects: string[];
  missingSecrets: string[];
  recommendedActions: string[];
}

export interface ProductionBuildFile {
  path: string;
  content: string | Buffer;
  size: number;
  contentType: string;
}

export interface ProductionBuildResult {
  success: boolean;
  fileCount: number;
  totalSize: number;
  entryPoint: string;
  files: ProductionBuildFile[];
  artifactPath?: string;
  artifactHash?: string;
  logs: DeploymentLogEntry[];
  error?: string;
}

export interface CustomDomainDnsRecord {
  type: string; // 'CNAME' | 'A' | 'TXT'
  name: string;
  value: string;
  ttl?: number;
}

export interface CustomDomainResult {
  domain: string;
  status: 'none' | 'pending_verification' | 'active' | 'failed';
  dnsRecords: CustomDomainDnsRecord[];
  sslStatus?: 'pending' | 'active' | 'failed';
  error?: string;
}

export type DeploymentLogger = (
  level: 'info' | 'warn' | 'error' | 'success',
  message: string,
  phase?: 'validation' | 'build' | 'deploy' | 'domain' | 'rollback'
) => void;

export interface DeploymentAdapter {
  readonly provider: DeploymentProviderType;
  readonly displayName: string;
  readonly description: string;
  readonly supportsCustomDomains: boolean;
  readonly supportsRollback: boolean;

  validateCredentials(credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }>;

  deploy(params: {
    deployment: DeploymentRecord;
    buildResult: ProductionBuildResult;
    files: ProductionBuildFile[];
    secrets: Record<string, string>;
    logger: DeploymentLogger;
  }): Promise<{
    success: boolean;
    targetUrl?: string;
    providerDeploymentId?: string;
    error?: string;
  }>;

  configureCustomDomain?(params: {
    deployment: DeploymentRecord;
    domain: string;
    logger: DeploymentLogger;
  }): Promise<CustomDomainResult>;

  verifyCustomDomain?(params: {
    deployment: DeploymentRecord;
    domain: string;
  }): Promise<{ verified: boolean; message?: string }>;

  rollback?(params: {
    currentDeployment: DeploymentRecord;
    targetDeployment: DeploymentRecord;
    logger: DeploymentLogger;
  }): Promise<{
    success: boolean;
    targetUrl?: string;
    error?: string;
  }>;
}
