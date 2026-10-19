import crypto from 'crypto';
import { CacheCategory, CacheEntry, CacheStats } from './types.js';

export interface CacheLookupParams {
  category: CacheCategory;
  userId?: string;
  buildId?: string;
  modelId: string;
  inputs: Record<string, any> | string;
  config?: Record<string, any>;
  bypassCache?: boolean;
}

export interface CacheStoreParams<T = any> {
  category: CacheCategory;
  userId?: string;
  buildId?: string;
  modelId: string;
  inputs: Record<string, any> | string;
  config?: Record<string, any>;
  data: T;
  estimatedTokensSaved: number;
  ttlSeconds?: number;
}

export class SafeResultCache {
  private static instance: SafeResultCache;
  private cache: Map<string, CacheEntry> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    entriesCount: 0,
    tokensSaved: 0,
    estimatedCostSaved: 0
  };

  // Sensitive patterns that must NEVER be cached
  private readonly SENSITIVE_PATTERNS = [
    /sk-[a-zA-Z0-9]{20,}/i,
    /ghp_[a-zA-Z0-9]{30,}/i,
    /bearer\s+[a-zA-Z0-9._-]{20,}/i,
    /-----BEGIN (RSA|EC|PRIVATE) KEY-----/i,
    /password\s*[:=]\s*["'][^"']+["']/i,
    /encryption_secret/i
  ];

  private constructor() {}

  static getInstance(): SafeResultCache {
    if (!SafeResultCache.instance) {
      SafeResultCache.instance = new SafeResultCache();
    }
    return SafeResultCache.instance;
  }

  /**
   * Generates a deterministic SHA-256 cache key including user scope, category, model, inputs, and config
   */
  generateKey(params: {
    category: CacheCategory;
    userId?: string;
    modelId: string;
    inputs: Record<string, any> | string;
    config?: Record<string, any>;
  }): { key: string; inputHash: string } {
    const serializedInputs = typeof params.inputs === 'string'
      ? params.inputs
      : JSON.stringify(params.inputs, Object.keys(params.inputs).sort());

    const serializedConfig = params.config
      ? JSON.stringify(params.config, Object.keys(params.config).sort())
      : '';

    const inputHash = crypto
      .createHash('sha256')
      .update(serializedInputs + ':' + serializedConfig)
      .digest('hex');

    // Strict multi-tenant isolation: always partition by userId if provided
    const userScope = params.userId || 'global_public';

    const fullKey = crypto
      .createHash('sha256')
      .update(`${userScope}:${params.category}:${params.modelId}:${inputHash}`)
      .digest('hex');

    return { key: fullKey, inputHash };
  }

  /**
   * Checks for sensitive credentials in the content to prevent accidental leakage
   */
  private containsSensitiveData(data: any): boolean {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const pattern of this.SENSITIVE_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Retrieves an item from cache if valid and unexpired
   */
  get<T = any>(params: CacheLookupParams): T | null {
    if (params.bypassCache) {
      this.stats.misses++;
      return null;
    }

    const { key } = this.generateKey({
      category: params.category,
      userId: params.userId,
      modelId: params.modelId,
      inputs: params.inputs,
      config: params.config
    });

    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.entriesCount = this.cache.size;
      this.stats.misses++;
      return null;
    }

    // Hit!
    entry.hits++;
    this.stats.hits++;
    this.stats.tokensSaved += entry.estimatedTokensSaved;
    this.stats.estimatedCostSaved += entry.estimatedTokensSaved * 0.000003;

    return entry.data as T;
  }

  /**
   * Stores a result safely into the cache
   */
  set<T = any>(params: CacheStoreParams<T>): boolean {
    // Safety check: Never cache secrets or auth credentials
    if (this.containsSensitiveData(params.inputs) || this.containsSensitiveData(params.data)) {
      console.warn(`[CACHE] Refused to cache entry for ${params.category}: sensitive data pattern detected.`);
      return false;
    }

    const { key, inputHash } = this.generateKey({
      category: params.category,
      userId: params.userId,
      modelId: params.modelId,
      inputs: params.inputs,
      config: params.config
    });

    const now = Date.now();
    const ttlMs = (params.ttlSeconds || 3600) * 1000; // Default 1 hour TTL

    const entry: CacheEntry<T> = {
      key,
      category: params.category,
      userId: params.userId,
      buildId: params.buildId,
      modelId: params.modelId,
      inputHash,
      data: params.data,
      estimatedTokensSaved: params.estimatedTokensSaved,
      hits: 0,
      createdAt: now,
      expiresAt: now + ttlMs
    };

    this.cache.set(key, entry);
    this.stats.entriesCount = this.cache.size;
    return true;
  }

  /**
   * Invalidates entries for a build or category when underlying source files change
   */
  invalidateBuild(buildId: string): number {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.buildId === buildId) {
        this.cache.delete(key);
        count++;
      }
    }
    this.stats.entriesCount = this.cache.size;
    return count;
  }

  /**
   * Invalidates user cache
   */
  invalidateUser(userId: string): number {
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.userId === userId) {
        this.cache.delete(key);
        count++;
      }
    }
    this.stats.entriesCount = this.cache.size;
    return count;
  }

  /**
   * Returns cache metrics for dashboard
   */
  getStats(): CacheStats {
    return { ...this.stats, entriesCount: this.cache.size };
  }

  /**
   * Clears all cache entries (e.g. for testing)
   */
  clear(): void {
    this.cache.clear();
    this.stats.entriesCount = 0;
  }
}

export const safeResultCache = SafeResultCache.getInstance();
