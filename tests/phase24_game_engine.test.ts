import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  createDemoWorld,
  stepWorld,
  playerOf,
  animationFrame,
  playerAnimState,
  cameraFor,
  defaultSettings,
  FixedStepLoop,
  FIXED_DT
} from '../server/gameEngine/engine2d.js';
import { jumpSound, coinSound, hitSound, parseWav, encodeWav } from '../server/gameEngine/audio.js';
import { AssetManager } from '../server/gameEngine/assets.js';
import { GameServer, webSocketAccept, encodeFrame, decodeFrame } from '../server/gameEngine/multiplayer.js';
import { profileSimulation } from '../server/gameEngine/profiler.js';
import { GameProjectGenerator } from '../server/gameEngine/gameProjectGenerator.js';

const BASE = path.join(process.cwd(), '.tmp_game_tests');
const NO_INPUT = { left: false, right: false, jump: false };

function settle(world: ReturnType<typeof createDemoWorld>, steps: number = 90): void {
  for (let i = 0; i < steps; i++) stepWorld(world, NO_INPUT);
}

describe('SquadForge Phase 24: Game Development Engine Test Suite', () => {
  before(() => fs.mkdirSync(BASE, { recursive: true }));
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. 2D physics & collisions', () => {
    test('1.1 Gravity pulls the player down; the ground stops the fall', () => {
      const world = createDemoWorld();
      const player = playerOf(world);
      assert.equal(player.grounded, false);
      settle(world);
      assert.equal(player.grounded, true);
      assert.equal(player.y, 420 - 40); // resting exactly on the ground platform
      assert.equal(player.vy, 0);
    });

    test('1.2 Running moves at the design speed; jumping arcs and lands', () => {
      const world = createDemoWorld();
      settle(world);
      const player = playerOf(world);
      const startX = player.x;
      for (let i = 0; i < 60; i++) stepWorld(world, { left: false, right: true, jump: false });
      assert.ok(Math.abs(player.x - startX - 240) < 30, `expected ~240px of travel, got ${player.x - startX}`);
      // Jump
      stepWorld(world, { left: false, right: false, jump: true });
      assert.ok(player.vy < 0, 'jump must give upward velocity');
      let apex = player.y;
      for (let i = 0; i < 120; i++) {
        stepWorld(world, NO_INPUT);
        apex = Math.min(apex, player.y);
      }
      assert.ok(apex < 380 - 50, 'player must rise well above the ground');
      assert.equal(player.grounded, true);
    });

    test('1.3 The simulation is deterministic (same inputs, same world)', () => {
      const a = createDemoWorld();
      const b = createDemoWorld();
      const script = [
        { left: false, right: true, jump: false },
        { left: false, right: true, jump: true },
        { left: true, right: false, jump: false }
      ];
      for (let i = 0; i < 300; i++) {
        const input = script[Math.floor(i / 50) % script.length];
        stepWorld(a, input);
        stepWorld(b, input);
      }
      assert.deepEqual(
        a.entities.map((e) => [e.x, e.y, e.alive]),
        b.entities.map((e) => [e.x, e.y, e.alive])
      );
      assert.equal(a.score, b.score);
    });

    test('1.4 FixedStepLoop advances whole steps only', () => {
      const world = createDemoWorld();
      const loop = new FixedStepLoop(world);
      const steps = loop.advance(FIXED_DT * 2.5, NO_INPUT);
      assert.equal(steps, 2);
    });
  });

  describe('2. Gameplay interactions', () => {
    test('2.1 Coins are collected for score; the goal wins the game', () => {
      const world = createDemoWorld();
      settle(world);
      const player = playerOf(world);
      const coin = world.entities.find((e) => e.kind === 'coin')!;
      player.x = coin.x;
      player.y = coin.y;
      stepWorld(world, NO_INPUT);
      assert.equal(coin.alive, false);
      assert.equal(world.coinsCollected, 1);
      assert.equal(world.score, 100);
      const goal = world.entities.find((e) => e.kind === 'goal')!;
      player.x = goal.x;
      player.y = goal.y;
      stepWorld(world, NO_INPUT);
      assert.equal(world.state, 'won');
      assert.equal(world.score, 600);
    });

    test('2.2 Stomping an enemy scores; touching it sideways loses', () => {
      const world = createDemoWorld();
      settle(world);
      const player = playerOf(world);
      const enemy = world.entities.find((e) => e.kind === 'enemy')!;
      player.x = enemy.x;
      player.y = enemy.y - player.h - 2;
      player.vy = 300; // falling onto it
      stepWorld(world, NO_INPUT);
      assert.equal(enemy.alive, false);
      assert.equal(world.score, 200);
      assert.equal(world.state, 'playing');

      const world2 = createDemoWorld();
      settle(world2);
      const player2 = playerOf(world2);
      const enemy2 = world2.entities.find((e) => e.kind === 'enemy')!;
      player2.x = enemy2.x - player2.w + 2;
      player2.y = enemy2.y;
      stepWorld(world2, NO_INPUT);
      assert.equal(world2.state, 'lost');
    });
  });

  describe('3. Animation, camera, settings', () => {
    test('3.1 Frame selection, camera clamping, settings defaults', () => {
      assert.equal(animationFrame(0, 4, 8, 'idle'), 0);
      assert.equal(animationFrame(0.26, 4, 8, 'run'), 2);
      assert.equal(animationFrame(0, 4, 8, 'air'), 3);
      const world = createDemoWorld();
      const player = playerOf(world);
      player.x = 0;
      assert.equal(cameraFor(world, 480, 480).x, 0);
      player.x = 930;
      assert.equal(cameraFor(world, 480, 480).x, 960 - 480);
      player.x = 100; // (x=930 overlaps the goal, which would end the game)
      settle(world); // land first — a fresh player starts mid-air ('air' state)
      assert.equal(playerAnimState(player), 'idle');
      const settings = defaultSettings();
      assert.equal(settings.controls.jump, 'Space');
      assert.ok(settings.sfxVolume > 0 && settings.sfxVolume <= 1);
    });
  });

  describe('4. Procedural audio (real WAV data)', () => {
    test('4.1 Synthesized SFX are valid WAVs with the right durations', () => {
      const jump = parseWav(jumpSound());
      assert.equal(jump.channels, 1);
      assert.equal(jump.bitsPerSample, 16);
      assert.ok(Math.abs(jump.durationSec - 0.15) < 0.01);
      const coin = parseWav(coinSound());
      assert.ok(Math.abs(coin.durationSec - 0.25) < 0.01);
      const hit = parseWav(hitSound());
      assert.ok(hit.durationSec > 0.2);
      assert.throws(() => parseWav(Buffer.from('NOPE')), /Not a WAV/);
      const roundTrip = parseWav(encodeWav(new Float32Array(2205), 22050));
      assert.equal(roundTrip.durationSec, 0.1);
    });
  });

  describe('5. Asset management', () => {
    test('5.1 Registration rules and on-disk validation with hashes', () => {
      const dir = path.join(BASE, 'proj');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'coin.wav'), coinSound());
      const assets = new AssetManager();
      assets.register({ id: 'coin-sfx', kind: 'sound', path: 'coin.wav' });
      assets.register({ id: 'missing-sprite', kind: 'sprite', path: 'hero.png' });
      assert.throws(() => assets.register({ id: 'bad', kind: 'sound', path: 'x.png' }), /not valid for kind/);
      assert.throws(() => assets.register({ id: 'coin-sfx', kind: 'sound', path: 'y.wav' }), /Duplicate/);
      const validation = assets.validate(dir);
      assert.equal(validation.valid, false);
      assert.ok(validation.problems.some((p) => p.includes('missing-sprite')));
      assert.ok(assets.get('coin-sfx').sha256);
      fs.writeFileSync(path.join(dir, 'hero.png'), Buffer.from([0x89, 0x50]));
      assert.equal(assets.validate(dir).valid, true);
    });
  });

  describe('6. Playable HTML5 demo (the shipped code, simulated)', () => {
    test('6.1 game.js parses, its core lands the player and collects a coin', async () => {
      const files = GameProjectGenerator.generateHtml5Game('Coin Quest');
      assert.ok(files['index.html'] && files['styles.css'] && files['game.js']);
      const gamePath = path.join(BASE, 'game.js');
      fs.writeFileSync(gamePath, files['game.js']);
      execFileSync('node', ['--check', gamePath]); // whole file incl. browser glue is valid JS
      const cjsPath = path.join(BASE, 'game.cjs');
      fs.writeFileSync(cjsPath, files['game.js']);
      const { createRequire } = await import('module');
      const core = createRequire(import.meta.url)(cjsPath);
      const world = core.createWorld();
      const none = { left: false, right: false, jump: false };
      for (let i = 0; i < 90; i++) core.step(world, none);
      const player = world.entities[0];
      assert.equal(player.grounded, true);
      assert.equal(player.y, 380);
      // Walk right, jump onto the first platform, and grab its coin
      let collected = false;
      let jumped = false;
      for (let i = 0; i < 600 && !collected; i++) {
        const shouldJump = !jumped && player.grounded && player.x >= 105 && player.x <= 125;
        if (shouldJump) jumped = true;
        core.step(world, { left: false, right: true, jump: shouldJump });
        if (world.coins > 0) collected = true;
        if (world.state !== 'playing') break;
      }
      assert.ok(collected || world.score > 0, `expected progress in the demo, state=${world.state} score=${world.score} x=${player.x}`);
    });
  });

  describe('7. Multiplayer (authoritative WebSocket server)', () => {
    test('7.1 Frame codec round-trips; handshake math is RFC 6455', () => {
      assert.equal(webSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
      const frame = encodeFrame('{"hello":1}');
      const decoded = decodeFrame(frame);
      assert.equal(decoded?.payload.toString(), '{"hello":1}');
    });

    test('7.2 Two clients play; the server owns movement; cheats are ignored', async () => {
      const server = new GameServer();
      const port = await server.start(0);
      const url = `ws://127.0.0.1:${port}`;
      const mkClient = (): { ws: WebSocket; messages: any[] } => {
        const ws = new WebSocket(url);
        const messages: any[] = [];
        ws.addEventListener('message', (event: any) => {
          try { messages.push(JSON.parse(String(event.data))); } catch { /* ignore */ }
        });
        return { ws, messages };
      };
      const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (!cond()) {
          if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      try {
        const a = mkClient();
        const b = mkClient();
        await waitFor(() => a.messages.some((m) => m.type === 'welcome'), 'welcome A');
        await waitFor(() => b.messages.some((m) => m.type === 'welcome'), 'welcome B');
        await waitFor(() => server.stats().clients === 2, 'two clients registered');
        a.ws.send(JSON.stringify({ type: 'join', name: 'Sheroz' }));
        // Baseline state
        await waitFor(() => a.messages.some((m) => m.type === 'state'), 'first state');
        const x0 = a.messages.filter((m) => m.type === 'state').at(-1).you.x;
        // Hold "right" for a while
        let seq = 1;
        const sendInput = setInterval(() => {
          a.ws.send(JSON.stringify({ type: 'input', seq: seq++, left: false, right: true, jump: false }));
        }, 30);
        await waitFor(() => {
          const states = a.messages.filter((m) => m.type === 'state');
          return states.length > 0 && states.at(-1).you.x > x0 + 30;
        }, 'server-side movement from inputs');
        clearInterval(sendInput);
        // Cheat attempt: claim a teleported position (with a fresh seq)
        const before = a.messages.filter((m) => m.type === 'state').at(-1).you.x;
        a.ws.send(JSON.stringify({ type: 'input', seq: seq++, left: false, right: false, jump: false, x: 99999, y: -500 }));
        await new Promise((r) => setTimeout(r, 300));
        const after = a.messages.filter((m) => m.type === 'state').at(-1).you.x;
        assert.ok(after < 2000, `position claim must be ignored (x went ${before} -> ${after}, not 99999)`);
        // Stale sequence numbers are dropped: replaying seq=1 must not move the player backwards/forwards unexpectedly
        a.ws.send(JSON.stringify({ type: 'input', seq: 1, left: true, right: false, jump: false }));
        await new Promise((r) => setTimeout(r, 200));
        const finalX = a.messages.filter((m) => m.type === 'state').at(-1).you.x;
        assert.ok(Math.abs(finalX - after) < 40, 'stale input must not be applied');
        // Scoreboard shows both players
        const state = a.messages.filter((m) => m.type === 'state').at(-1);
        assert.equal(state.scoreboard.length, 2);
        a.ws.close();
        await waitFor(() => server.stats().clients === 1, 'disconnect cleanup');
        b.ws.close();
      } finally {
        await server.stop();
      }
    });
  });

  describe('8. Performance profiling', () => {
    test('8.1 The demo simulation runs well inside the frame budget', () => {
      const report = profileSimulation(1800);
      assert.equal(report.steps, 1800);
      assert.equal(report.entities, 10);
      assert.equal(report.withinBudget, true, `msPerStep=${report.msPerStep}`);
      assert.ok(report.stepsPerSecond > 1000);
    });
  });

  describe('9. Generated game projects', () => {
    test('9.1 WinForms 3D game is complete on the Phase 21 stack', () => {
      const config = GameProjectGenerator.getDefaultConfig('CubeQuest');
      const files = GameProjectGenerator.generateWinForms3dGame(config);
      for (const expected of [
        'CubeQuest.sln',
        'src/CubeQuest/CubeQuest.csproj',
        'src/CubeQuest/Program.cs',
        'src/CubeQuest/MainForm.cs',
        'src/CubeQuest/SceneDocument.cs',
        'src/CubeQuest/Viewport3D.cs'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      assert.match(files['src/CubeQuest/MainForm.cs'], /CubeQuest/);
      assert.match(files['src/CubeQuest/MainForm.cs'], /OnKeyDown/);
      assert.match(files['src/CubeQuest/MainForm.cs'], /Score/);
    });
  });
});
