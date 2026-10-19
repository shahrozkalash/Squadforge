import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// Server-side secret key derived or loaded from environment
const ENCRYPTION_KEY_RAW = process.env.ENCRYPTION_SECRET || 'squadforge-production-master-encryption-key-2026';
const KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW).digest();
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts sensitive text (e.g. GitHub OAuth tokens) using AES-256-GCM
 */
export function encryptToken(plainText: string): string {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts encrypted text using AES-256-GCM
 */
export function decryptToken(cipherPackage: string): string {
  if (!cipherPackage) return '';
  try {
    const parts = cipherPackage.split(':');
    if (parts.length !== 3) return '';
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Failed to decrypt token securely');
    return '';
  }
}

/**
 * Hashes a plain password using secure bcrypt with salt rounds 12
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(plainPassword, salt);
}

/**
 * Compares a plaintext password against a stored bcrypt hash
 */
export async function verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
  if (!plainPassword || !hash) return false;
  return bcrypt.compare(plainPassword, hash);
}

/**
 * Generates a cryptographically secure random session token
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hashes a session token for safe storage at rest
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
