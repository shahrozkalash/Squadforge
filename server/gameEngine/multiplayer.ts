import * as crypto from 'crypto';
import * as http from 'http';
import { Socket } from 'net';
import { World, InputState, createDemoWorld, stepWorld, playerOf, FIXED_DT } from './engine2d.js';

/**
 * Phase 24: authoritative multiplayer foundations.
 *
 * Transport: a dependency-free RFC 6455 WebSocket server (handshake,
 * masked frame parsing, text/ping/pong/close). Authority: clients
 * send ONLY input intents ({type:'input', seq, left, right, jump});
 * the server owns every world and simulates it with the Phase 24
 * engine at a fixed timestep. A client cannot move its player by
 * claiming a position — position fields are not part of the
 * protocol and are ignored, and inputs are sequence-checked and
 * rate-limited. Sessions are instanced (each player gets a world),
 * sharing a lobby scoreboard broadcast.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function webSocketAccept(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

export function encodeFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

export function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, bytesConsumed: offset + length };
}

interface Client {
  id: string;
  name: string;
  socket: Socket;
  buffer: Buffer;
  world: World;
  input: InputState;
  lastSeq: number;
  inputsThisSecond: number;
  windowStart: number;
}

export interface ServerStats {
  clients: number;
  tick: number;
  uptimeSec: number;
}

export class GameServer {
  private server: http.Server | null = null;
  private clients = new Map<string, Client>();
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  public port = 0;

  public async start(port: number = 0): Promise<number> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket upgrade required');
    });
    this.server.on('upgrade', (req, socket: Socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = webSocketAccept(String(key));
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      this.addClient(socket);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as any).port as number;
    this.startedAt = Date.now();
    // 20 Hz broadcast; simulation advances 3 fixed steps per tick (60 Hz)
    this.timer = setInterval(() => this.onTick(), 50);
    this.timer.unref?.();
    return this.port;
  }

  private addClient(socket: Socket): void {
    const id = crypto.randomUUID().slice(0, 8);
    const client: Client = {
      id,
      name: `player-${id}`,
      socket,
      buffer: Buffer.alloc(0),
      world: createDemoWorld(),
      input: { left: false, right: false, jump: false },
      lastSeq: 0,
      inputsThisSecond: 0,
      windowStart: Date.now()
    };
    this.clients.set(id, client);
    socket.on('data', (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(client.buffer);
        if (!frame) break;
        client.buffer = client.buffer.subarray(frame.bytesConsumed);
        this.onFrame(client, frame);
      }
    });
    const cleanup = (): void => {
      this.clients.delete(id);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    this.send(client, { type: 'welcome', playerId: id, tickRate: 20, stepRate: 60 });
  }

  private onFrame(client: Client, frame: DecodedFrame): void {
    if (frame.opcode === 0x8) {
      client.socket.end();
      this.clients.delete(client.id);
      return;
    }
    if (frame.opcode === 0x9) {
      // pong: FIN + opcode 0xA, echo payload
      const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]);
      client.socket.write(pong);
      return;
    }
    if (frame.opcode !== 0x1) return;
    let message: any;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      return; // malformed JSON is dropped, never trusted
    }
    if (message.type === 'join' && typeof message.name === 'string') {
      client.name = message.name.slice(0, 24);
      return;
    }
    if (message.type === 'input') {
      // Rate limit: at most 120 inputs per second per client
      const now = Date.now();
      if (now - client.windowStart >= 1000) {
        client.windowStart = now;
        client.inputsThisSecond = 0;
      }
      if (++client.inputsThisSecond > 120) return;
      // Sequence check: stale or replayed inputs are dropped.
      if (typeof message.seq === 'number') {
        if (message.seq <= client.lastSeq) return;
        client.lastSeq = message.seq;
      }
      // ONLY intent fields are read. Any position/state fields a
      // client sends are ignored by construction — the server
      // simulates the world itself.
      client.input = {
        left: message.left === true,
        right: message.right === true,
        jump: message.jump === true
      };
    }
    // Unknown message types are ignored (no client authority).
  }

  private onTick(): void {
    this.tick++;
    for (const client of this.clients.values()) {
      for (let i = 0; i < 3; i++) stepWorld(client.world, client.input, FIXED_DT);
    }
    const scoreboard = [...this.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      score: c.world.score,
      state: c.world.state
    }));
    for (const client of this.clients.values()) {
      const player = playerOf(client.world);
      this.send(client, {
        type: 'state',
        tick: this.tick,
        you: { x: Math.round(player.x), y: Math.round(player.y), score: client.world.score, state: client.world.state },
        scoreboard
      });
    }
  }

  private send(client: Client, message: object): void {
    try {
      client.socket.write(encodeFrame(JSON.stringify(message)));
    } catch {
      /* client is gone; cleanup happens on close */
    }
  }

  public stats(): ServerStats {
    return { clients: this.clients.size, tick: this.tick, uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
