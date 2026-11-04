// Forwards TCP from a published port to one fixed sandbox address.
// The published port has no authentication of its own, so it must stay on a private address.
import net from 'node:net';

const targetHost = process.env.RELAY_TARGET_HOST;
const targetPort = Number(process.env.RELAY_TARGET_PORT);
const listenPort = Number(process.env.RELAY_LISTEN_PORT || 8080);

if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  console.error('RELAY_TARGET_HOST and RELAY_TARGET_PORT are required');
  process.exit(1);
}

net.createServer(client => {
  const upstream = net.connect(targetPort, targetHost);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}).listen(listenPort, '0.0.0.0');

process.on('SIGTERM', () => process.exit(0));
