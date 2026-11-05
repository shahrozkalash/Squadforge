// Forwards TCP from a published port to one fixed sandbox address.
// A client must send `SF-RELAY <token>\n` first, so reaching the port is not enough to reach the project.
import crypto from 'node:crypto';
import net from 'node:net';

const targetHost = process.env.RELAY_TARGET_HOST;
const targetPort = Number(process.env.RELAY_TARGET_PORT);
const listenPort = Number(process.env.RELAY_LISTEN_PORT || 8080);
const token = process.env.RELAY_TOKEN;

const MAX_PREAMBLE_BYTES = 128;
const PREAMBLE_TIMEOUT_MS = 5000;

if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !token) {
  console.error('RELAY_TARGET_HOST, RELAY_TARGET_PORT, and RELAY_TOKEN are required');
  process.exit(1);
}

const digest = value => crypto.createHash('sha256').update(value).digest();
const expected = digest(`SF-RELAY ${token}`);

function forward(client, firstBytes) {
  const upstream = net.connect(targetPort, targetHost);
  if (firstBytes.length > 0) upstream.write(firstBytes);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.resume();
}

net.createServer(client => {
  let received = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), PREAMBLE_TIMEOUT_MS);

  const onData = chunk => {
    received = Buffer.concat([received, chunk]);
    const end = received.indexOf(0x0a);
    if (end === -1) {
      if (received.length > MAX_PREAMBLE_BYTES) client.destroy();
      return;
    }

    clearTimeout(timer);
    client.off('data', onData);
    client.pause();
    if (!crypto.timingSafeEqual(digest(received.subarray(0, end)), expected)) {
      client.destroy();
      return;
    }
    forward(client, received.subarray(end + 1));
  };

  client.on('data', onData);
  client.on('error', () => clearTimeout(timer));
  client.on('close', () => clearTimeout(timer));
}).listen(listenPort, '0.0.0.0');

process.on('SIGTERM', () => process.exit(0));
