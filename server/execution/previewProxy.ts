import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { PreviewSession } from '../types.js';
import { PreviewSessionService } from './previewSessionService.js';

// The __Host- prefix makes browsers refuse any version of this cookie set with a Domain
const COOKIE_NAME = '__Host-sf_preview';
const AUTH_PATH = '/__squadforge/auth';

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return undefined;
}

function removeCookie(header: string | undefined): string | undefined {
  const remaining = (header || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part && !part.startsWith(`${COOKIE_NAME}=`));
  return remaining.length > 0 ? remaining.join('; ') : undefined;
}

/** Project code never receives the preview credential, or the browser's real Host. */
function forwardedHeaders(req: http.IncomingMessage, preview: PreviewSession): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = `localhost:${preview.port}`;
  delete headers.authorization;
  const cookie = removeCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

/** The cookie is SameSite=None, so another site must not open a socket with it. */
function sameOriginUpgrade(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createPreviewServer(service: PreviewSessionService): http.Server {
  const { config } = service;
  const hostPattern = new RegExp(`^(pv[0-9a-f]{24})\\.${escapeForRegExp(config.baseDomain || '')}(?::\\d+)?$`, 'i');
  const frameAncestors = `frame-ancestors ${new URL(config.appOrigin).origin}`;

  const previewIdFor = (req: http.IncomingMessage) =>
    hostPattern.exec(req.headers.host || '')?.[1]?.toLowerCase() ?? null;

  const server = http.createServer((req, res) => {
    const previewId = previewIdFor(req);
    if (!previewId) {
      res.writeHead(404).end('Not found');
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://preview');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (url.pathname === AUTH_PATH) {
      const cookie = service.redeem(previewId, url.searchParams.get('token') || '');
      if (!cookie) {
        res.writeHead(403).end('This preview link is invalid or has expired.');
        return;
      }
      // The preview loads in a cross-site iframe, so the browser needs SameSite=None.
      // Browsers accept Secure on *.localhost, and the cookie stays limited to this host.
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${cookie}; HttpOnly; Path=/; Secure; SameSite=None`,
        Location: '/'
      });
      res.end();
      return;
    }

    const preview = service.authorize(previewId, readCookie(req.headers.cookie));
    if (!preview) {
      res.writeHead(403).end('You do not have access to this preview.');
      return;
    }

    const upstream = http.request({
      host: preview.relayHost,
      port: preview.relayPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, preview)
    }, upstreamRes => {
      const headers = { ...upstreamRes.headers };
      delete headers['x-frame-options'];
      const policy = headers['content-security-policy'];
      headers['content-security-policy'] = [
        ...(Array.isArray(policy) ? policy : policy ? [policy] : []),
        frameAncestors
      ];
      // A project must not set cookies on the app's domain
      headers['set-cookie'] = (headers['set-cookie'] || []).filter(cookie => !/;\s*domain\s*=/i.test(cookie));

      // Project responses are untrusted, and an invalid one must not throw here
      try {
        res.writeHead(upstreamRes.statusCode || 502, headers);
      } catch {
        upstreamRes.destroy();
        res.writeHead(502).end('The project sent an invalid response.');
        return;
      }
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });

    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('The project is not responding.');
    });
    req.pipe(upstream);
  });

  // WebSocket upgrades carry the same authorization as HTTP, for dev server hot reload
  server.on('upgrade', (req, socket: Duplex, head) => {
    const previewId = previewIdFor(req);
    const preview = previewId ? service.authorize(previewId, readCookie(req.headers.cookie)) : null;
    if (!preview || !sameOriginUpgrade(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const upstream = net.connect(preview.relayPort, preview.relayHost, () => {
      const headers = forwardedHeaders(req, preview);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`)
      );
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return server;
}
