import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';
import { Scene3dProjectGenerator } from '../scene3d/scene3dProjectGenerator.js';

/**
 * Phase 24: game project generators.
 *
 * 1) HTML5 platformer — a complete, genuinely playable game
 *    (menu / playing / pause / won / lost, keyboard controls,
 *    gravity + AABB platform physics, coins, a patrolling enemy with
 *    stomp, goal, HUD, WebAudio sound effects, settings for volume
 *    and mute). Its simulation core is pure JS with no DOM access
 *    and is exported for Node, so the exact code that ships in the
 *    game is the code the automated tests simulate.
 *
 * 2) WinForms 3D game — a C# game on the Phase 21 scene stack:
 *    steer a cube with the arrow keys, collect pickup cubes against
 *    the clock, score HUD. Compile-verified via the Phase 18 pipeline.
 */

export const GAME_CORE_JS = `'use strict';
// ---- Simulation core (no DOM) — the same code the tests run ----
const GameCore = (() => {
  const SPEED = 240, JUMP = -640, GRAVITY = 1800, DT = 1 / 60;
  function entity(kind, x, y, w, h, extra) {
    return Object.assign({
      kind, x, y, w, h, vx: 0, vy: 0,
      solid: kind === 'platform',
      gravityAffected: kind === 'player' || kind === 'enemy',
      grounded: false, alive: true
    }, extra || {});
  }
  function createWorld() {
    return {
      width: 960, height: 480, gravity: GRAVITY, score: 0, coins: 0, state: 'playing', time: 0,
      entities: [
        entity('player', 40, 300, 28, 40),
        entity('platform', 0, 420, 960, 60),
        entity('platform', 160, 330, 120, 16),
        entity('platform', 360, 260, 120, 16),
        entity('platform', 560, 330, 120, 16),
        entity('coin', 200, 290, 18, 18, { gravityAffected: false }),
        entity('coin', 410, 220, 18, 18, { gravityAffected: false }),
        entity('coin', 610, 290, 18, 18, { gravityAffected: false }),
        entity('enemy', 700, 388, 30, 32, { vx: 60, patrolMinX: 690, patrolMaxX: 880 }),
        entity('goal', 905, 356, 28, 64, { gravityAffected: false })
      ]
    };
  }
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  function step(world, input, dt) {
    dt = dt || DT;
    if (world.state !== 'playing') return world;
    world.time += dt;
    const player = world.entities[0];
    player.vx = (input.right ? SPEED : 0) - (input.left ? SPEED : 0);
    if (input.jump && player.grounded) { player.vy = JUMP; player.grounded = false; }
    for (const e of world.entities) {
      if (!e.alive) continue;
      if (e.kind === 'enemy') {
        if (e.x <= e.patrolMinX) e.vx = Math.abs(e.vx || 60);
        if (e.x >= e.patrolMaxX) e.vx = -Math.abs(e.vx || 60);
      }
      if (e.gravityAffected) e.vy += world.gravity * dt;
      e.x += e.vx * dt;
      for (const o of world.entities) {
        if (o === e || !o.solid || !o.alive) continue;
        if (overlaps(e, o)) { if (e.vx > 0) e.x = o.x - e.w; else if (e.vx < 0) e.x = o.x + o.w; }
      }
      e.y += e.vy * dt;
      e.grounded = false;
      for (const o of world.entities) {
        if (o === e || !o.solid || !o.alive) continue;
        if (overlaps(e, o)) {
          if (e.vy > 0) { e.y = o.y - e.h; e.vy = 0; e.grounded = true; }
          else if (e.vy < 0) { e.y = o.y + o.h; e.vy = 0; }
        }
      }
      e.x = Math.max(0, Math.min(world.width - e.w, e.x));
      if (e.y > world.height + 200) { e.alive = false; if (e.kind === 'player') world.state = 'lost'; }
    }
    for (const e of world.entities) {
      if (!e.alive || e === player) continue;
      if (!overlaps(player, e)) continue;
      if (e.kind === 'coin') { e.alive = false; world.coins++; world.score += 100; }
      else if (e.kind === 'enemy') {
        if (player.vy > 0 && player.y + player.h - e.y < e.h * 0.6) { e.alive = false; world.score += 200; player.vy = JUMP * 0.6; }
        else world.state = 'lost';
      } else if (e.kind === 'goal') { world.state = 'won'; world.score += 500; }
    }
    return world;
  }
  return { createWorld, step, DT, SPEED, JUMP, GRAVITY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GameCore;
`;

const BROWSER_GLUE_JS = `
// ---- Browser glue: canvas rendering, input, audio, menus ----
// Guarded so the file can also be loaded in Node (tests use the core).
if (typeof document !== 'undefined') (function () {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const settings = { sfxVolume: 0.9, muted: false };
  let audioCtx = null;
  function beep(freqFrom, freqTo, ms, type) {
    if (settings.muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freqFrom, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), audioCtx.currentTime + ms / 1000);
      gain.gain.setValueAtTime(settings.sfxVolume * 0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) { /* audio unavailable — game continues silently */ }
  }
  const COLORS = { player: '#f59e0b', platform: '#475569', coin: '#facc15', enemy: '#ef4444', goal: '#22c55e' };
  const GROUND = '#334155';
  let world = GameCore.createWorld();
  let mode = 'menu'; // menu | playing | paused | won | lost
  const input = { left: false, right: false, jump: false };
  const seen = { coins: 0, state: 'playing' };
  const keys = {};
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = true;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = true;
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { input.jump = true; e.preventDefault(); }
    if (e.code === 'KeyM') settings.muted = !settings.muted;
    if (e.code === 'KeyP' && mode === 'playing') mode = 'paused';
    else if (e.code === 'KeyP' && mode === 'paused') mode = 'playing';
    if (e.code === 'Enter' && mode === 'menu') mode = 'playing';
    if (e.code === 'KeyR' && (mode === 'won' || mode === 'lost' || mode === 'paused')) { world = GameCore.createWorld(); seen.coins = 0; mode = 'playing'; }
  });
  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = false;
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') input.jump = false;
  });
  let last = performance.now(), acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const elapsed = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (mode === 'playing') {
      acc += elapsed;
      while (acc >= GameCore.DT) {
        const wasGrounded = world.entities[0].grounded;
        GameCore.step(world, input, GameCore.DT);
        acc -= GameCore.DT;
        if (input.jump && wasGrounded && !world.entities[0].grounded) beep(300, 900, 150);
      }
      if (world.coins > seen.coins) { beep(1318, 1975, 180); seen.coins = world.coins; }
      if (world.state !== 'playing' && seen.state === 'playing') {
        if (world.state === 'won') beep(523, 1046, 300); else beep(220, 55, 250, 'square');
        mode = world.state;
      }
      seen.state = world.state;
    }
    draw();
  }
  function draw() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const e of world.entities) {
      if (!e.alive) continue;
      ctx.fillStyle = e.kind === 'platform' && e.y >= 420 ? GROUND : (COLORS[e.kind] || '#fff');
      ctx.fillRect(e.x, e.y, e.w, e.h);
      if (e.kind === 'coin') { ctx.fillStyle = '#a16207'; ctx.fillRect(e.x + 6, e.y + 4, 6, 10); }
      if (e.kind === 'goal') { ctx.fillStyle = '#bbf7d0'; ctx.fillRect(e.x + 4, e.y + 4, 20, 10); }
    }
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '16px system-ui';
    ctx.fillText('Score: ' + world.score + '   Coins: ' + world.coins + '/3' + (settings.muted ? '   [muted]' : ''), 12, 24);
    ctx.textAlign = 'center';
    if (mode === 'menu') overlay('COIN QUEST', 'Arrow keys / WASD to move, Space to jump. Stomp the red enemy!', 'Press Enter to start — P pauses, M mutes, R restarts');
    if (mode === 'paused') overlay('PAUSED', '', 'Press P to resume');
    if (mode === 'won') overlay('YOU WIN! Score ' + world.score, '', 'Press R to play again');
    if (mode === 'lost') overlay('GAME OVER — Score ' + world.score, '', 'Press R to try again');
    ctx.textAlign = 'left';
  }
  function overlay(title, line1, line2) {
    ctx.fillStyle = 'rgba(2,6,23,0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 40px system-ui';
    ctx.fillText(title, canvas.width / 2, 210);
    ctx.font = '16px system-ui';
    if (line1) ctx.fillText(line1, canvas.width / 2, 250);
    if (line2) ctx.fillText(line2, canvas.width / 2, 280);
  }
  requestAnimationFrame(frame);
})();
`;

export class GameProjectGenerator {
  public static generateHtml5Game(appName: string): Record<string, string> {
    const title = appName || 'Coin Quest';
    return {
      'index.html':
        `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<title>${title}</title>\n<link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n` +
        `<h1>${title}</h1>\n<canvas id="game" width="960" height="480"></canvas>\n` +
        `<p class="hint">Move: ← → or A/D · Jump: Space · Pause: P · Mute: M · Restart: R</p>\n` +
        `<script src="game.js"></script>\n</body>\n</html>\n`,
      'styles.css':
        `body { background: #020617; color: #e2e8f0; font-family: system-ui, sans-serif; text-align: center; }\ncanvas { background: #0f172a; border: 2px solid #334155; border-radius: 8px; max-width: 96vw; }\n.hint { color: #94a3b8; }\n`,
      'game.js': GAME_CORE_JS + BROWSER_GLUE_JS,
      'README.md':
        `# ${title}\n\nA complete, playable 2D platformer generated by SquadForge (Phase 24 Game Development Engine).\n\n## Play\nOpen \`index.html\` in a browser. Collect the 3 coins, stomp or avoid the enemy, reach the green goal.\n\n## Structure\n- \`game.js\` — simulation core (pure, testable in Node via \`module.exports\`) + browser glue (rendering, input, WebAudio SFX, menus)\n- The core uses a fixed 60 Hz timestep with AABB physics — the same mechanics as the server engine in \`server/gameEngine/engine2d.ts\`.\n`
    };
  }

  public static getDefaultConfig(appName: string = 'CubeQuest'): DesktopProjectConfig {
    return DesktopProjectGenerator.getDefaultConfig(appName, appName.replace(/[^a-zA-Z0-9_]/g, ''));
  }

  /** A 3D game on the Phase 21 stack: steer a cube, collect spheres, beat the clock. */
  public static generateWinForms3dGame(config: DesktopProjectConfig): Record<string, string> {
    const files = Scene3dProjectGenerator.generateProjectFiles(config);
    const asm = config.assemblyName;
    const root = `src/${asm}`;

    files[`${root}/MainForm.cs`] =
      `namespace ${asm};\n\n` +
      `/// <summary>\n` +
      `/// CubeQuest: a 3D collection game on the Phase 21 scene stack.\n` +
      `/// Arrow keys steer the hero cube on the ground plane; touching\n` +
      `/// a green pickup cube collects it (+100). Collect all 5 before\n` +
      `/// the 60 s timer ends. The viewport re-renders each tick.\n` +
      `/// </summary>\n` +
      `public sealed class MainForm : Form\n{\n` +
      `    private readonly SceneDocument _scene = new();\n` +
      `    private readonly Viewport3D _viewport = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly Label _hud = new() { Dock = DockStyle.Top, Height = 28, Font = new Font("Segoe UI", 12) };\n` +
      `    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 33 };\n` +
      `    private readonly SceneNode _hero;\n` +
      `    private readonly List<SceneNode> _pickups = new();\n` +
      `    private int _score;\n` +
      `    private double _timeLeft = 60;\n` +
      `    private bool _over;\n\n` +
      `    public MainForm()\n    {\n` +
      `        Text = "${config.appName} — CubeQuest";\n` +
      `        Width = 1100; Height = 760;\n` +
      `        KeyPreview = true;\n\n` +
      `        _hero = _scene.AddNode("Hero");\n` +
      `        _hero.Mesh = SceneDocument.CreateCube(1.2f);\n` +
      `        _hero.Color = new[] { 0.95f, 0.6f, 0.1f };\n` +
      `        _hero.Position = new[] { 0f, 0.6f, 0f };\n` +
      `        var rng = new Random(42);\n` +
      `        for (int i = 0; i < 5; i++)\n        {\n` +
      `            var pickup = _scene.AddNode($"Pickup {i + 1}");\n` +
      `            pickup.Mesh = SceneDocument.CreateCube(0.7f);\n` +
      `            pickup.Color = new[] { 0.3f, 0.85f, 0.4f };\n` +
      `            pickup.Position = new[] { rng.NextSingle() * 14 - 7, 0.35f, rng.NextSingle() * 14 - 7 };\n` +
      `            _pickups.Add(pickup);\n        }\n` +
      `        _viewport.Scene = _scene;\n` +
      `        Controls.Add(_viewport); Controls.Add(_hud);\n` +
      `        _timer.Tick += (_, _) => Tick();\n` +
      `        _timer.Start();\n` +
      `        UpdateHud();\n    }\n\n` +
      `    protected override void OnKeyDown(KeyEventArgs e)\n    {\n` +
      `        const float step = 0.45f;\n` +
      `        if (e.KeyCode == Keys.Left) _hero.Position[0] -= step;\n` +
      `        if (e.KeyCode == Keys.Right) _hero.Position[0] += step;\n` +
      `        if (e.KeyCode == Keys.Up) _hero.Position[2] -= step;\n` +
      `        if (e.KeyCode == Keys.Down) _hero.Position[2] += step;\n` +
      `        _hero.Position[0] = Math.Clamp(_hero.Position[0], -9, 9);\n` +
      `        _hero.Position[2] = Math.Clamp(_hero.Position[2], -9, 9);\n    }\n\n` +
      `    private void Tick()\n    {\n` +
      `        if (_over) return;\n` +
      `        _timeLeft -= 0.033;\n` +
      `        foreach (var pickup in _pickups.ToList())\n        {\n` +
      `            var dx = pickup.Position[0] - _hero.Position[0];\n` +
      `            var dz = pickup.Position[2] - _hero.Position[2];\n` +
      `            if (dx * dx + dz * dz < 1.1f)\n            {\n` +
      `                _scene.Nodes.Remove(pickup);\n` +
      `                _pickups.Remove(pickup);\n` +
      `                _score += 100;\n            }\n        }\n` +
      `        if (_pickups.Count == 0) { _over = true; _hud.Text = $"YOU WIN! Score {_score} with {_timeLeft:0.0}s to spare"; _timer.Stop(); }\n` +
      `        else if (_timeLeft <= 0) { _over = true; _hud.Text = $"TIME UP — Score {_score}"; _timer.Stop(); }\n` +
      `        UpdateHud();\n` +
      `        _viewport.Invalidate();\n    }\n\n` +
      `    private void UpdateHud()\n    {\n` +
      `        if (!_over) _hud.Text = $"Score: {_score}   Pickups left: {_pickups.Count}   Time: {_timeLeft:0.0}s   (arrow keys to move)";\n    }\n}\n`;

    files['README.md'] =
      `# ${config.appName} — CubeQuest (3D game)\n\nA playable 3D collection game generated by SquadForge (Phase 24) on the Phase 21 3D engine and Phase 18 desktop stack.\n\nSteer the orange cube with the arrow keys, collect all 5 green cubes before 60 seconds run out. Rendering is the Phase 21 software viewport (orbit with the mouse, zoom with the wheel).\n\nBuild: open the .sln in Visual Studio 2022 or run \`dotnet build\`.\n`;
    return files;
  }
}
