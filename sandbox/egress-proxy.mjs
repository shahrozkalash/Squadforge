// HTTPS CONNECT proxy that only reaches allowlisted hosts on port 443.
// Dependency installs use it, so they can reach the package registry and nothing else.
import http from 'node:http';
import net from 'node:net';

const allowedHosts = new Set(
  (process.env.EGRESS_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
);
const listenPort = Number(process.env.EGRESS_LISTEN_PORT || 3128);

if (allowedHosts.size === 0) {
  console.error('EGRESS_ALLOWED_HOSTS is required');
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Only HTTPS CONNECT to allowlisted hosts is permitted\n');
});

server.on('connect', (req, client, head) => {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(req.url || '');
  const host = match?.[1].toLowerCase();

  if (!host || match?.[2] !== '443' || !allowedHosts.has(host)) {
    console.log(`denied ${req.url}`);
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const upstream = net.connect(443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

server.listen(listenPort, '0.0.0.0', () => console.log('egress-proxy-ready'));
process.on('SIGTERM', () => process.exit(0));
