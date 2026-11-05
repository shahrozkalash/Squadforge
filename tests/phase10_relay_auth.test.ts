import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import net, { AddressInfo } from 'node:net';
import path from 'node:path';

const TOKEN = 'a'.repeat(64);

async function freePort(): Promise<number> {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => probe.once('listening', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

describe('Preview relay authentication', () => {
  let relay: ChildProcess;
  let target: net.Server;
  let relayPort: number;
  let targetConnections = 0;

  before(async () => {
    target = net.createServer(socket => {
      targetConnections++;
      socket.on('data', chunk => socket.write(chunk));
      socket.on('error', () => undefined);
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => target.once('listening', resolve));

    relayPort = await freePort();
    relay = spawn(process.execPath, [path.resolve('sandbox/relay.mjs')], {
      env: {
        RELAY_TARGET_HOST: '127.0.0.1',
        RELAY_TARGET_PORT: String((target.address() as AddressInfo).port),
        RELAY_LISTEN_PORT: String(relayPort),
        RELAY_TOKEN: TOKEN
      },
      stdio: 'ignore'
    });

    for (let attempt = 0; attempt < 100; attempt++) {
      const up = await new Promise<boolean>(resolve => {
        const socket = net.connect(relayPort, '127.0.0.1', () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
      });
      if (up) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The relay did not start');
  });

  after(async () => {
    relay.kill();
    target.close();
  });

  /** Sends bytes, and returns what came back before the relay closed or the wait ended. */
  function exchange(payload: string, waitMs = 400): Promise<{ reply: string; closed: boolean }> {
    return new Promise(resolve => {
      let reply = '';
      let closed = false;
      const socket = net.connect(relayPort, '127.0.0.1', () => socket.write(payload));
      socket.on('data', chunk => { reply += chunk.toString(); });
      socket.on('close', () => { closed = true; });
      socket.on('error', () => undefined);
      setTimeout(() => {
        socket.destroy();
        resolve({ reply, closed });
      }, waitMs);
    });
  }

  test('the right token forwards everything after it, in the same packet', async () => {
    const { reply } = await exchange(`SF-RELAY ${TOKEN}\nhello project`);
    assert.equal(reply, 'hello project');
  });

  test('a plain HTTP request never reaches the project', async () => {
    const before = targetConnections;
    const { reply, closed } = await exchange('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.equal(reply, '');
    assert.equal(closed, true);
    assert.equal(targetConnections, before);
  });

  test('a wrong token never reaches the project', async () => {
    const before = targetConnections;
    const { reply, closed } = await exchange(`SF-RELAY ${'b'.repeat(64)}\nhello`);
    assert.equal(reply, '');
    assert.equal(closed, true);
    assert.equal(targetConnections, before);
  });

  test('an endless first line is cut off', async () => {
    const before = targetConnections;
    const { closed } = await exchange('x'.repeat(4096));
    assert.equal(closed, true);
    assert.equal(targetConnections, before);
  });

  test('the relay refuses to start without a token', async () => {
    const code = await new Promise<number | null>(resolve => {
      spawn(process.execPath, [path.resolve('sandbox/relay.mjs')], {
        env: { RELAY_TARGET_HOST: '127.0.0.1', RELAY_TARGET_PORT: '80' },
        stdio: 'ignore'
      }).on('exit', resolve);
    });
    assert.equal(code, 1);
  });
});
