import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// Server-side secret key derived or loaded from environment
export function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: ENCRYPTION_SECRET environment variable is missing in production environment. A unique, high-entropy 32+ character key is required.');
    }
    return crypto.createHash('sha256').update('squadforge-development-master-encryption-key-2026').digest();
  }
  if (process.env.NODE_ENV === 'production' && (secret === 'squadforge-development-master-encryption-key-2026' || secret.length < 32)) {
    throw new Error('FATAL: ENCRYPTION_SECRET is insecure or too short for production (must be at least 32 characters and not the default key).');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts sensitive text (e.g. GitHub OAuth tokens) using AES-256-GCM
 */
export function encryptToken(plainText: string): string {
  if (!plainText) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
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
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
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

/**
 * Generates a cryptographically secure 6-digit numeric verification code
 */
export function generateVerificationCode(): string {
  // Generates integer between 100000 and 999999 inclusive
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Computes a keyed HMAC-SHA256 hash of a verification code.
 * Ensures the verification code is never stored in plaintext at rest.
 */
export function hashVerificationCode(code: string): string {
  const key = getEncryptionKey();
  return crypto.createHmac('sha256', key).update(code.trim()).digest('hex');
}

/**
 * Constant-time verification of a provided code against a stored HMAC hash
 */
export function timingSafeVerifyCodeHash(code: string, storedHash: string): boolean {
  if (!code || !storedHash) return false;
  const computedHash = hashVerificationCode(code);
  const bufA = Buffer.from(computedHash, 'hex');
  const bufB = Buffer.from(storedHash, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates a cryptographically secure reset authorization token (post-OTP verification)
 */
export function generateResetAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hashes a reset authorization token for safe storage at rest
 */
export function hashResetAuthToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

