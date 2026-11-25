import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { db } from '../store.js';
import { Build, ExecutionSession, PreviewSession } from '../types.js';
import { PreviewEndpoint } from './executionBackend.js';
import { ExecutionError, ExecutionSessionManager } from './executionSessionManager.js';

const TOKEN_TTL_MS = 60 * 1000;

export interface PreviewConfig {
  baseDomain: string | null;
  scheme: 'http' | 'https';
  publicPort: number | null;
  listenPort: number;
  appOrigin: string;
  idleTimeoutMs: number;
  portWaitMs: number;
  portPollMs: number;
  /** Phase 32: HMAC secret for signed preview link tokens. Falls back to ENCRYPTION_SECRET, then an ephemeral per-process secret. */
  tokenSecret?: string;
  /** Phase 32: when both are set, the preview listener terminates TLS itself. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

export function previewConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewConfig {
  const production = env.NODE_ENV === 'production';
  const listenPort = Number(env.PREVIEW_PORT) || 3001;
  return {
    // A production preview needs its own domain. It must never share the app's origin.
    baseDomain: env.PREVIEW_BASE_DOMAIN || (production ? null : 'preview.localhost'),
    scheme: production ? 'https' : 'http',
    publicPort: production ? null : listenPort,
    listenPort,
    appOrigin: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
    idleTimeoutMs: (Number(env.PREVIEW_IDLE_MINUTES) || 15) * 60 * 1000,
    portWaitMs: 30000,
    portPollMs: 500,
    tokenSecret: env.PREVIEW_TOKEN_SECRET || env.ENCRYPTION_SECRET || undefined,
    tlsCertPath: env.PREVIEW_TLS_CERT || undefined,
    tlsKeyPath: env.PREVIEW_TLS_KEY || undefined
  };
}

/**
 * Phase 32: preview link tokens are HMAC-signed and bound to one
 * preview, one execution session and one owner, with the expiry inside
 * the signature so it cannot be extended by editing the token. The
 * stored one-time hash in the preview record still applies on top:
 * a token redeems exactly once, within its lifetime.
 */
export interface PreviewTokenPayload {
  pid: string;
  sid: string;
  uid: string;
  exp: number;
}

export function signPreviewToken(secret: string, payload: PreviewTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyPreviewToken(secret: string, token: string): PreviewTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (
    typeof payload?.pid !== 'string' || typeof payload?.sid !== 'string' ||
    typeof payload?.uid !== 'string' || typeof payload?.exp !== 'number'
  ) {
    return null;
  }
  if (Date.now() > payload.exp) return null;
  return payload;
}

/** Used only when no PREVIEW_TOKEN_SECRET/ENCRYPTION_SECRET is configured; links then die with the process. */
const EPHEMERAL_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function matches(secret: string, expectedHash: string | undefined): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export class PreviewSessionService {
  private readonly tokenSecret: string;

  constructor(private readonly manager: ExecutionSessionManager, readonly config: PreviewConfig) {
    manager.onProcessEnded = session => this.closeForSession(session);
    this.tokenSecret =
      config.tokenSecret || process.env.PREVIEW_TOKEN_SECRET || process.env.ENCRYPTION_SECRET || EPHEMERAL_TOKEN_SECRET;
  }

  /** A signed, expiring, one-time link token bound to this preview, its session and its owner. */
  private issueToken(preview: Pick<PreviewSession, 'id' | 'sessionId' | 'userId'>): { token: string; expiresAt: number } {
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = signPreviewToken(this.tokenSecret, {
      pid: preview.id,
      sid: preview.sessionId,
      uid: preview.userId,
      exp: expiresAt
    });
    return { token, expiresAt };
  }

  private urlFor(previewId: string, path: string): string {
    const port = this.config.publicPort ? `:${this.config.publicPort}` : '';
    return `${this.config.scheme}://${previewId}.${this.config.baseDomain}${port}${path}`;
  }

  private async waitForPort(processId: string): Promise<number | null> {
    const deadline = Date.now() + this.config.portWaitMs;
    while (Date.now() < deadline) {
      const ports = await this.manager.backend.listeningPorts(processId).catch(() => []);
      if (ports.length > 0) return ports.includes(3000) ? 3000 : ports[0];
      await new Promise(resolve => setTimeout(resolve, this.config.portPollMs));
    }
    return null;
  }

  /** The relay takes a moment to start, and a preview opened before then shows an error. */
  private async waitForRelay({ host, port, token }: PreviewEndpoint): Promise<void> {
    const deadline = Date.now() + this.config.portWaitMs;
    while (Date.now() < deadline) {
      const reachable = await new Promise<boolean>(resolve => {
        const req = http.get({
          path: '/',
          timeout: 2000,
          createConnection: () => {
            const socket = net.connect(port, host);
            if (token) socket.write(`SF-RELAY ${token}\n`);
            return socket;
          }
        }, res => {
          res.resume();
          resolve(true);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
      });
      if (reachable) return;
      await new Promise(resolve => setTimeout(resolve, this.config.portPollMs));
    }
  }

  /** Opens a preview and returns a one-time URL for the build owner. */
  async open(build: Build, sessionId: string): Promise<{ preview: PreviewSession; url: string }> {
    if (!this.config.baseDomain) {
      throw new ExecutionError('Previews need PREVIEW_BASE_DOMAIN to be configured on this server.', 503);
    }

    const session = db.getExecutionSession(sessionId);
    if (!session || session.buildId !== build.id) {
      throw new ExecutionError('Execution session not found', 404);
    }
    if (session.status !== 'running' || !session.processId) {
      throw new ExecutionError('Start a development server before opening a preview.', 409);
    }

    const port = await this.waitForPort(session.processId);
    if (port === null) {
      throw new ExecutionError('The project did not start listening on a port.', 504);
    }

    await this.closeForSession(session);
    const endpoint = await this.manager.backend.openPreview(session.id, session.processId, port);
    await this.waitForRelay(endpoint);

    if (db.getExecutionSession(session.id)?.status !== 'running') {
      await this.manager.backend.closePreview(session.id).catch(() => undefined);
      throw new ExecutionError('The project stopped while the preview was opening.', 409);
    }

    const now = Date.now();
    const previewId = `pv${crypto.randomBytes(12).toString('hex')}`;
    const { token, expiresAt } = this.issueToken({ id: previewId, sessionId: session.id, userId: build.userId });
    const preview = db.savePreviewSession({
      id: previewId,
      sessionId: session.id,
      buildId: build.id,
      userId: build.userId,
      status: 'active',
      port,
      relayHost: endpoint.host,
      relayPort: endpoint.port,
      relayToken: endpoint.token,
      tokenHash: hashSecret(token),
      tokenExpiresAt: expiresAt,
      createdAt: now,
      lastAccessAt: now
    });

    return { preview, url: this.urlFor(preview.id, `/__squadforge/auth?token=${token}`) };
  }

  /** Issues a fresh one-time URL for a preview that is already open. */
  refreshToken(build: Build, previewId: string): string {
    const preview = db.getPreviewSession(previewId);
    if (!preview || preview.buildId !== build.id || preview.status !== 'active') {
      throw new ExecutionError('Preview not found', 404);
    }
    const { token, expiresAt } = this.issueToken(preview);
    db.savePreviewSession({ ...preview, tokenHash: hashSecret(token), tokenExpiresAt: expiresAt });
    return this.urlFor(preview.id, `/__squadforge/auth?token=${token}`);
  }

  /** Exchanges a one-time token for a cookie that only works on this preview's host. */
  redeem(previewId: string, token: string): string | null {
    const preview = db.getPreviewSession(previewId);
    if (!preview || preview.status !== 'active') return null;
    // The signature must verify and bind the token to this preview,
    // its session and its owner, before the one-time hash is consulted.
    const payload = verifyPreviewToken(this.tokenSecret, token);
    if (!payload || payload.pid !== previewId) return null;
    if (payload.sid !== preview.sessionId || payload.uid !== preview.userId) return null;
    if (!preview.tokenExpiresAt || Date.now() > preview.tokenExpiresAt) return null;
    if (!matches(token, preview.tokenHash)) return null;

    const cookie = crypto.randomBytes(32).toString('hex');
    db.savePreviewSession({
      ...preview,
      tokenHash: undefined,
      tokenExpiresAt: undefined,
      cookieHash: hashSecret(cookie),
      lastAccessAt: Date.now()
    });
    return cookie;
  }

  /** Returns the target for an authorized request. The URL never influences the target. */
  authorize(previewId: string, cookie: string | undefined): PreviewSession | null {
    if (!cookie) return null;
    const preview = db.getPreviewSession(previewId);
    if (!preview || preview.status !== 'active' || !matches(cookie, preview.cookieHash)) return null;

    const build = db.getBuild(preview.buildId);
    if (!build || build.userId !== preview.userId) return null;

    const now = Date.now();
    if (now - preview.lastAccessAt > 5000) db.savePreviewSession({ ...preview, lastAccessAt: now });
    return preview;
  }

  async close(build: Build, previewId: string): Promise<void> {
    const preview = db.getPreviewSession(previewId);
    if (!preview || preview.buildId !== build.id) throw new ExecutionError('Preview not found', 404);
    await this.manager.backend.closePreview(preview.sessionId);
    db.savePreviewSession({ ...preview, status: 'closed' });
  }

  async closeForSession(session: ExecutionSession): Promise<void> {
    for (const preview of db.getActivePreviews(session.id)) {
      await this.manager.backend.closePreview(session.id).catch(() => undefined);
      db.savePreviewSession({ ...preview, status: 'closed' });
    }
  }

  async reap(now = Date.now()): Promise<void> {
    for (const preview of db.getActivePreviews()) {
      if (now - preview.lastAccessAt > this.config.idleTimeoutMs) {
        await this.manager.backend.closePreview(preview.sessionId).catch(() => undefined);
        db.savePreviewSession({ ...preview, status: 'closed' });
      }
    }
  }
}
