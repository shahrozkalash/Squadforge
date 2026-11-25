/**
 * Phase 24: deterministic 2D game engine core — fixed-timestep
 * simulation with AABB physics, axis-separated collision resolution,
 * sprite animation timing, a follow camera, and game settings. The
 * same mechanics are generated into the playable HTML5 demo, and the
 * multiplayer server simulates with this exact code (server
 * authority is real, not asserted).
 */

export interface Entity {
  id: string;
  kind: 'player' | 'platform' | 'coin' | 'enemy' | 'goal' | 'decoration';
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  solid: boolean;
  gravityAffected: boolean;
  grounded: boolean;
  alive: boolean;
  /** Enemy patrol bounds. */
  patrolMinX?: number;
  patrolMaxX?: number;
  color: string;
}

export interface InputState {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export interface GameSettings {
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  difficulty: 'easy' | 'normal' | 'hard';
  controls: { left: string; right: string; jump: string };
}

export const defaultSettings = (): GameSettings => ({
  musicVolume: 0.6,
  sfxVolume: 0.9,
  difficulty: 'normal',
  controls: { left: 'ArrowLeft', right: 'ArrowRight', jump: 'Space' }
});

export interface World {
  width: number;
  height: number;
  gravity: number; // px/s^2
  entities: Entity[];
  score: number;
  coinsCollected: number;
  state: 'menu' | 'playing' | 'won' | 'lost';
  timeSec: number;
}

export const FIXED_DT = 1 / 60;
export const PLAYER_SPEED = 240; // px/s
export const JUMP_VELOCITY = -640; // px/s
export const ENEMY_SPEED = 60;

let nextId = 1;
export function makeEntity(partial: Partial<Entity> & { kind: Entity['kind'] }): Entity {
  return {
    id: `e${nextId++}`,
    x: 0, y: 0, w: 32, h: 32, vx: 0, vy: 0,
    solid: partial.kind === 'platform',
    gravityAffected: partial.kind === 'player' || partial.kind === 'enemy',
    grounded: false, alive: true, color: '#ffffff',
    ...partial
  };
}

/** The demo level: ground, platforms, coins, a patrolling enemy, a goal. */
export function createDemoWorld(): World {
  const entities: Entity[] = [
    makeEntity({ kind: 'player', x: 40, y: 300, w: 28, h: 40, color: '#f59e0b' }),
    makeEntity({ kind: 'platform', x: 0, y: 420, w: 960, h: 60, color: '#334155' }),
    makeEntity({ kind: 'platform', x: 160, y: 330, w: 120, h: 16, color: '#475569' }),
    makeEntity({ kind: 'platform', x: 360, y: 260, w: 120, h: 16, color: '#475569' }),
    makeEntity({ kind: 'platform', x: 560, y: 330, w: 120, h: 16, color: '#475569' }),
    makeEntity({ kind: 'coin', x: 200, y: 290, w: 18, h: 18, gravityAffected: false, color: '#facc15' }),
    makeEntity({ kind: 'coin', x: 410, y: 220, w: 18, h: 18, gravityAffected: false, color: '#facc15' }),
    makeEntity({ kind: 'coin', x: 610, y: 290, w: 18, h: 18, gravityAffected: false, color: '#facc15' }),
    makeEntity({ kind: 'enemy', x: 700, y: 388, w: 30, h: 32, vx: ENEMY_SPEED, patrolMinX: 690, patrolMaxX: 880, color: '#ef4444' }),
    makeEntity({ kind: 'goal', x: 905, y: 356, w: 28, h: 64, gravityAffected: false, color: '#22c55e' })
  ];
  return { width: 960, height: 480, gravity: 1800, entities, score: 0, coinsCollected: 0, state: 'playing', timeSec: 0 };
}

export function playerOf(world: World): Entity {
  return world.entities.find((e) => e.kind === 'player')!;
}

const overlaps = (a: Entity, b: Entity): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * One fixed simulation step. Pure with respect to (world, input, dt):
 * the same sequence of inputs always produces the same world, which
 * is what makes the engine testable and the multiplayer server
 * authoritative.
 */
export function stepWorld(world: World, input: InputState, dt: number = FIXED_DT): void {
  if (world.state !== 'playing') return;
  world.timeSec += dt;
  const player = playerOf(world);

  // Player control
  player.vx = (input.right ? PLAYER_SPEED : 0) - (input.left ? PLAYER_SPEED : 0);
  if (input.jump && player.grounded) {
    player.vy = JUMP_VELOCITY;
    player.grounded = false;
  }

  for (const e of world.entities) {
    if (!e.alive) continue;
    if (e.kind === 'enemy') {
      if (e.patrolMinX !== undefined && e.x <= e.patrolMinX) e.vx = Math.abs(e.vx || ENEMY_SPEED);
      if (e.patrolMaxX !== undefined && e.x >= e.patrolMaxX) e.vx = -Math.abs(e.vx || ENEMY_SPEED);
    }
    if (e.gravityAffected) e.vy += world.gravity * dt;

    // Integrate X, resolve against solids
    e.x += e.vx * dt;
    if (e.solid || e.kind === 'player' || e.kind === 'enemy') {
      for (const other of world.entities) {
        if (other === e || !other.solid || !other.alive) continue;
        if (overlaps(e, other)) {
          if (e.vx > 0) e.x = other.x - e.w;
          else if (e.vx < 0) e.x = other.x + other.w;
        }
      }
    }
    // Integrate Y, resolve against solids
    e.y += e.vy * dt;
    e.grounded = false;
    if (e.solid || e.kind === 'player' || e.kind === 'enemy') {
      for (const other of world.entities) {
        if (other === e || !other.solid || !other.alive) continue;
        if (overlaps(e, other)) {
          if (e.vy > 0) {
            e.y = other.y - e.h;
            e.vy = 0;
            e.grounded = true;
          } else if (e.vy < 0) {
            e.y = other.y + other.h;
            e.vy = 0;
          }
        }
      }
    }
    e.x = Math.max(0, Math.min(world.width - e.w, e.x));
    if (e.y > world.height + 200) {
      e.alive = false;
      if (e.kind === 'player') world.state = 'lost';
    }
  }

  // Interactions (player vs pickups / hazards / goal)
  for (const e of world.entities) {
    if (!e.alive || e === player) continue;
    if (!overlaps(player, e)) continue;
    if (e.kind === 'coin') {
      e.alive = false;
      world.coinsCollected++;
      world.score += 100;
    } else if (e.kind === 'enemy') {
      // Stomp check: player falling onto the enemy's top half
      if (player.vy > 0 && player.y + player.h - e.y < e.h * 0.6) {
        e.alive = false;
        world.score += 200;
        player.vy = JUMP_VELOCITY * 0.6;
      } else {
        world.state = 'lost';
      }
    } else if (e.kind === 'goal') {
      world.state = 'won';
      world.score += 500;
    }
  }
}

/** Sprite animation: frame index for a looping strip. */
export function animationFrame(timeSec: number, frameCount: number, fps: number, state: 'idle' | 'run' | 'air'): number {
  if (state === 'idle') return 0;
  if (state === 'air') return frameCount - 1;
  return Math.floor(timeSec * fps) % frameCount;
}

export function playerAnimState(player: Entity): 'idle' | 'run' | 'air' {
  if (!player.grounded) return 'air';
  return Math.abs(player.vx) > 1 ? 'run' : 'idle';
}

/** Follow camera clamped to the level. */
export function cameraFor(world: World, viewWidth: number, viewHeight: number): { x: number; y: number } {
  const player = playerOf(world);
  const cx = player.x + player.w / 2 - viewWidth / 2;
  const cy = player.y + player.h / 2 - viewHeight / 2;
  return {
    x: Math.max(0, Math.min(Math.max(0, world.width - viewWidth), cx)),
    y: Math.max(0, Math.min(Math.max(0, world.height - viewHeight), cy))
  };
}

/** Fixed-timestep accumulator: how many steps to run for elapsed real time. */
export class FixedStepLoop {
  private accumulator = 0;
  constructor(private readonly world: World) {}
  public advance(elapsedSec: number, input: InputState): number {
    this.accumulator += Math.min(elapsedSec, 0.25); // spiral-of-death guard
    let steps = 0;
    while (this.accumulator >= FIXED_DT) {
      stepWorld(this.world, input, FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    return steps;
  }
}
