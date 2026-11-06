/**
 * SquadForge Phase 15: Secure Deployment Secret & Environment Variable Manager
 * Enforces AES-256-GCM encryption at rest. Never exposes raw plaintext secrets in UI/API responses.
 */

import crypto from 'node:crypto';
import { db } from '../store.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { DeploymentSecretRecord, SafeDeploymentSecret } from './types.js';

export class DeploymentSecretManager {
  /**
   * Masks secret values so they can be safely displayed in the user interface.
   * e.g. "sk-proj-12345678" -> "••••••••5678"
   */
  static maskSecretValue(plainText: string): string {
    if (!plainText) return '••••••••';
    const trimmed = plainText.trim();
    if (trimmed.length <= 4) {
      return '••••••••';
    }
    const suffix = trimmed.slice(-4);
    return `••••••••${suffix}`;
  }

  /**
   * Stores a new or updated encrypted secret for a project.
   */
  static setSecret(params: {
    userId: string;
    buildId: string;
    key: string;
    value: string;
    environment?: string; // 'all' | 'production' | 'staging' | 'preview'
  }): SafeDeploymentSecret {
    const { userId, buildId, key, value, environment = 'all' } = params;

    const normalizedKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!normalizedKey) {
      throw new Error('Secret key name is required and must contain alphanumeric characters or underscores.');
    }

    if (value === undefined || value === null) {
      throw new Error('Secret value cannot be undefined or null.');
    }

    const encryptedValue = encryptToken(value);
    const existing = db.getDeploymentSecrets(buildId)
      .find(s => s.key === normalizedKey && (s.environment === environment || s.environment === 'all'));

    const now = Date.now();
    const secretRecord: DeploymentSecretRecord = {
      id: existing ? existing.id : `sec_${crypto.randomUUID()}`,
      buildId,
      userId,
      key: normalizedKey,
      encryptedValue,
      environment,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    db.saveDeploymentSecret(secretRecord);

    return {
      id: secretRecord.id,
      buildId: secretRecord.buildId,
      key: secretRecord.key,
      maskedValue: this.maskSecretValue(value),
      environment: secretRecord.environment,
      createdAt: secretRecord.createdAt,
      updatedAt: secretRecord.updatedAt
    };
  }

  /**
   * Retrieves all secrets for a project with masked values (safe for client responses).
   */
  static listSafeSecrets(buildId: string, environment?: string): SafeDeploymentSecret[] {
    const rawSecrets = db.getDeploymentSecrets(buildId, environment);
    return rawSecrets.map(s => {
      const decrypted = decryptToken(s.encryptedValue);
      return {
        id: s.id,
        buildId: s.buildId,
        key: s.key,
        maskedValue: this.maskSecretValue(decrypted),
        environment: s.environment,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      };
    });
  }

  /**
   * Retrieves decrypted secrets strictly for internal deployment runtime execution.
   * NEVER pass this result to client API responses.
   */
  static getDecryptedSecrets(buildId: string, environment: string = 'production'): Record<string, string> {
    const rawSecrets = db.getDeploymentSecrets(buildId);
    const result: Record<string, string> = {};

    for (const secret of rawSecrets) {
      // Include if secret applies to all environments or matches target environment
      if (secret.environment === 'all' || secret.environment === environment) {
        const decrypted = decryptToken(secret.encryptedValue);
        if (decrypted) {
          result[secret.key] = decrypted;
        }
      }
    }

    return result;
  }

  /**
   * Deletes a deployment secret.
   */
  static deleteSecret(secretId: string, userId: string, buildId: string): boolean {
    const secret = db.getDeploymentSecret(secretId);
    if (!secret) return false;
    if (secret.buildId !== buildId || secret.userId !== userId) {
      throw new Error('Forbidden: You do not own this secret.');
    }
    db.deleteDeploymentSecret(secretId);
    return true;
  }
}
