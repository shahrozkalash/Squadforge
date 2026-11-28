import vm from 'node:vm';

/**
 * Factory Phase F7 — headless playability check for generated HTML5
 * games.
 *
 * Phase 24 proved the shipped platformer's simulation core by loading
 * it in its own test suite and playing it with scripted inputs. This
 * module turns that evidence style into a reusable workflow gate: it
 * takes a built project's files and returns a verdict — playable or
 * not — from actually executing the game's DOM-free simulation core.
 *
 * How it runs the game: the generated `game.js` is written so its
 * simulation core has no DOM access and exports itself for Node
 * (`module.exports = GameCore`), while the browser glue is guarded by
 * `typeof document !== 'undefined'`. The checker evaluates the exact
 * shipped bytes in a `node:vm` context whose only globals are a
 * `module`/`exports` pair and a silent console — no `require`, no
 * `process`, no host bindings — so the core executes headlessly and
 * the glue stays inert, exactly as it does when Node loads the file.
 *
 * The assertions are deterministic and behavioural, not cosmetic:
 *   1. the package is complete (index.html loads game.js on a canvas);
 *   2. game.js parses and executes with no runtime error;
 *   3. the core exposes createWorld/step and a world with a player;
 *   4. the loop ticks: under no input the player falls and lands
 *      grounded at the world's resting height (physics runs);
 *   5. input changes state: holding "right" moves the player at the
 *      design speed;
 *   6. gameplay progresses: a scripted play (walk + timed jump, the
 *      Phase 24 test 6.1 script) collects a coin for score;
 *   7. the simulation is deterministic: the same scripted play from a
 *      fresh world lands on identical state.
 *
 * A screenshot or a static HTML file can pass none of these. Any
 * runtime error thrown by the game at load or during simulation is
 * captured into `runtimeErrors` and makes the verdict not playable.
 */

export interface PlayabilityCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GamePlayabilityReport {
  playable: boolean;
  stepsSimulated: number;
  checks: PlayabilityCheckResult[];
  runtimeErrors: string[];
  finalState?: {
    state: string;
    score: number;
    coins: number;
    playerX: number;
    playerY: number;
    grounded: boolean;
  };
}

export type PlayabilityFileInput =
  | Record<string, string>
  | Array<{ path: string; content: string }>;

interface GameCoreLike {
  createWorld: () => any;
  step: (world: any, input: { left: boolean; right: boolean; jump: boolean }, dt?: number) => any;
  DT: number;
}

const NO_INPUT = { left: false, right: false, jump: false };
const RIGHT = { left: false, right: true, jump: false };
/** Hard cap so a pathological core cannot loop the checker forever. */
const MAX_STEPS = 20_000;

function toFileMap(input: PlayabilityFileInput): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(input)) {
    for (const f of input) map.set(f.path, f.content);
  } else {
    for (const [path, content] of Object.entries(input)) map.set(path, content);
  }
  return map;
}

/** One scripted play: settle, then walk right and jump onto the first platform. */
function scriptedPlay(core: GameCoreLike, budget: { steps: number }): any {
  const world = core.createWorld();
  const player = world.entities[0];
  for (let i = 0; i < 90; i++) {
    core.step(world, NO_INPUT);
    budget.steps++;
  }
  let jumped = false;
  for (let i = 0; i < 600 && world.coins === 0 && world.state === 'playing'; i++) {
    const shouldJump = !jumped && player.grounded && player.x >= 105 && player.x <= 125;
    if (shouldJump) jumped = true;
    core.step(world, { left: false, right: true, jump: shouldJump });
    budget.steps++;
  }
  return world;
}

function summarize(world: any): { state: string; score: number; coins: number; playerX: number; playerY: number; grounded: boolean } {
  const player = world.entities[0];
  return {
    state: world.state,
    score: world.score,
    coins: world.coins,
    playerX: player.x,
    playerY: player.y,
    grounded: player.grounded
  };
}

export function checkGamePlayability(input: PlayabilityFileInput): GamePlayabilityReport {
  const files = toFileMap(input);
  const checks: PlayabilityCheckResult[] = [];
  const runtimeErrors: string[] = [];
  const budget = { steps: 0 };
  let finalState: GamePlayabilityReport['finalState'];

  const record = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  // 1. Package completeness: the page must load the game on a canvas.
  const html = files.get('index.html');
  const gameJs = files.get('game.js');
  const packageOk =
    typeof html === 'string' &&
    typeof gameJs === 'string' &&
    /<canvas[^>]*id=["']game["']/.test(html) &&
    /<script[^>]*src=["']game\.js["']/.test(html);
  record(
    'package completeness',
    packageOk,
    packageOk
      ? 'index.html renders a #game canvas and loads game.js; game.js is present.'
      : 'index.html must contain a <canvas id="game"> and a <script src="game.js">, and game.js must be in the package.'
  );
  if (typeof gameJs !== 'string') {
    return { playable: false, stepsSimulated: 0, checks, runtimeErrors, finalState };
  }

  // 2. The shipped bytes must parse.
  let script: vm.Script;
  try {
    script = new vm.Script(gameJs, { filename: 'game.js' });
    record('game.js parses', true, 'The shipped game.js compiles as a classic script.');
  } catch (err: any) {
    runtimeErrors.push(`Parse error in game.js: ${err?.message || String(err)}`);
    record('game.js parses', false, runtimeErrors[0]);
    return { playable: false, stepsSimulated: 0, checks, runtimeErrors, finalState };
  }

  // 3. Execute headlessly in an isolated context (no host bindings).
  let core: GameCoreLike | null = null;
  try {
    const sandbox: Record<string, unknown> = {
      module: { exports: {} as Record<string, unknown> },
      console: { log: () => {}, warn: () => {}, error: () => {} }
    };
    sandbox.exports = (sandbox.module as { exports: unknown }).exports;
    const context = vm.createContext(sandbox);
    script.runInContext(context, { timeout: 5_000 });
    const exported = (sandbox.module as { exports: any }).exports;
    if (exported && typeof exported.createWorld === 'function' && typeof exported.step === 'function') {
      core = exported as GameCoreLike;
      record(
        'headless execution',
        true,
        'game.js executed in an isolated vm context with no runtime error; the simulation core exported createWorld/step and the DOM glue stayed inert.'
      );
    } else {
      record(
        'headless execution',
        false,
        'game.js ran but did not export a simulation core (createWorld/step) — the package is not a simulatable game.'
      );
    }
  } catch (err: any) {
    runtimeErrors.push(`Runtime error while loading game.js: ${err?.message || String(err)}`);
    record('headless execution', false, runtimeErrors[runtimeErrors.length - 1]);
  }
  if (!core) {
    return { playable: false, stepsSimulated: 0, checks, runtimeErrors, finalState };
  }

  // 4–7. Behavioural simulation. Any throw from the game's own step
  // function is a runtime error and ends the simulation honestly.
  try {
    const world = core.createWorld();
    const player = world?.entities?.[0];
    const worldOk = !!world && world.state === 'playing' && !!player && player.kind === 'player';
    record(
      'world creation',
      worldOk,
      worldOk
        ? `createWorld produced a '${world.state}' world with a player and ${world.entities.length} entities.`
        : 'createWorld did not produce a playing world whose first entity is the player.'
    );
    if (!worldOk) {
      return { playable: false, stepsSimulated: budget.steps, checks, runtimeErrors, finalState };
    }

    // Loop ticks + physics: no input — the player must fall and land.
    for (let i = 0; i < 90 && budget.steps < MAX_STEPS; i++) {
      core.step(world, NO_INPUT);
      budget.steps++;
    }
    const landed = player.grounded === true && player.y === 380 && player.vy === 0;
    record(
      'loop ticks and physics settle',
      landed,
      landed
        ? 'After 90 no-input steps the player is grounded at the resting height (y=380) with zero vertical velocity.'
        : `After 90 no-input steps the player should be grounded at y=380, got grounded=${player.grounded}, y=${player.y}, vy=${player.vy}.`
    );

    // Input changes state: holding right moves the player ~240px in 60 steps.
    const x0 = player.x;
    for (let i = 0; i < 60 && budget.steps < MAX_STEPS; i++) {
      core.step(world, RIGHT);
      budget.steps++;
    }
    const travelled = player.x - x0;
    const inputOk = travelled > 100;
    record(
      'input changes state',
      inputOk,
      inputOk
        ? `Holding "right" for 60 steps moved the player ${Math.round(travelled)}px (design speed 240px/s).`
        : `Holding "right" for 60 steps moved the player only ${Math.round(travelled)}px — input is not driving the simulation.`
    );

    // Gameplay progresses: scripted play collects a coin, twice, identically.
    const playA = scriptedPlay(core, budget);
    const summaryA = summarize(playA);
    const progressOk = summaryA.coins >= 1 && summaryA.score >= 100;
    record(
      'gameplay progresses',
      progressOk,
      progressOk
        ? `Scripted play (walk + timed jump onto the first platform) collected ${summaryA.coins} coin(s) for score ${summaryA.score}.`
        : `Scripted play collected no coin (coins=${summaryA.coins}, score=${summaryA.score}, state=${summaryA.state}) — the game cannot be progressed.`
    );
    finalState = summaryA;

    const playB = scriptedPlay(core, budget);
    const summaryB = summarize(playB);
    const deterministic =
      summaryA.state === summaryB.state &&
      summaryA.score === summaryB.score &&
      summaryA.coins === summaryB.coins &&
      summaryA.playerX === summaryB.playerX &&
      summaryA.playerY === summaryB.playerY;
    record(
      'deterministic simulation',
      deterministic,
      deterministic
        ? 'The same scripted play from a fresh world produced identical state, score, and player position on both runs.'
        : `Two identical scripted plays diverged: ${JSON.stringify(summaryA)} vs ${JSON.stringify(summaryB)}.`
    );
  } catch (err: any) {
    runtimeErrors.push(`Runtime error during simulation: ${err?.message || String(err)}`);
    record('simulation run', false, runtimeErrors[runtimeErrors.length - 1]);
  }

  const playable = runtimeErrors.length === 0 && checks.every(c => c.passed);
  return { playable, stepsSimulated: budget.steps, checks, runtimeErrors, finalState };
}
