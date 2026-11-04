import crypto from 'node:crypto';
import http from 'node:http';
import { db } from '../store.js';
import { Build, ExecutionSession, PreviewSession } from '../types.js';
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
    portPollMs: 500
  };
}

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
  constructor(private readonly manager: ExecutionSessionManager, readonly config: PreviewConfig) {
    manager.onProcessEnded = session => this.closeForSession(session);
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
  private async waitForRelay(host: string, port: number): Promise<void> {
    const deadline = Date.now() + this.config.portWaitMs;
    while (Date.now() < deadline) {
      const reachable = await new Promise<boolean>(resolve => {
        const req = http.get({ host, port, path: '/', timeout: 2000 }, res => {
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
    await this.waitForRelay(endpoint.host, endpoint.port);

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const preview = db.savePreviewSession({
      id: `pv${crypto.randomBytes(12).toString('hex')}`,
      sessionId: session.id,
      buildId: build.id,
      userId: build.userId,
      status: 'active',
      port,
      relayHost: endpoint.host,
      relayPort: endpoint.port,
      tokenHash: hashSecret(token),
      tokenExpiresAt: now + TOKEN_TTL_MS,
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
    const token = crypto.randomBytes(32).toString('hex');
    db.savePreviewSession({ ...preview, tokenHash: hashSecret(token), tokenExpiresAt: Date.now() + TOKEN_TTL_MS });
    return this.urlFor(preview.id, `/__squadforge/auth?token=${token}`);
  }

  /** Exchanges a one-time token for a cookie that only works on this preview's host. */
  redeem(previewId: string, token: string): string | null {
    const preview = db.getPreviewSession(previewId);
    if (!preview || preview.status !== 'active') return null;
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
