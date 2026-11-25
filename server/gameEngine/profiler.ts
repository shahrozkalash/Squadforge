import { createDemoWorld, stepWorld, playerOf, FIXED_DT, type InputState } from './engine2d.js';

/**
 * Phase 24: performance profiling for generated games — runs the
 * real simulation headlessly with a scripted input pattern and
 * reports step cost, throughput and the frame budget verdict.
 */

export interface ProfileReport {
  steps: number;
  entities: number;
  totalMs: number;
  msPerStep: number;
  stepsPerSecond: number;
  frameBudgetMs: number;
  withinBudget: boolean;
  finalScore: number;
  finalState: string;
}

export function profileSimulation(steps: number = 3600): ProfileReport {
  const world = createDemoWorld();
  const script: InputState[] = [
    { left: false, right: true, jump: false },
    { left: false, right: true, jump: true },
    { left: false, right: false, jump: false },
    { left: true, right: false, jump: false }
  ];
  const started = performance.now();
  for (let i = 0; i < steps; i++) {
    stepWorld(world, script[Math.floor(i / 30) % script.length], FIXED_DT);
    if (world.state !== 'playing') {
      // Restart the demo world so the profile measures full steps
      const fresh = createDemoWorld();
      world.entities = fresh.entities;
      world.state = 'playing';
      world.score = 0;
      world.coinsCollected = 0;
      world.timeSec = 0;
    }
  }
  const totalMs = performance.now() - started;
  const msPerStep = totalMs / steps;
  void playerOf;
  return {
    steps,
    entities: world.entities.length,
    totalMs: Math.round(totalMs * 100) / 100,
    msPerStep: Math.round(msPerStep * 10000) / 10000,
    stepsPerSecond: Math.round(1 / (msPerStep / 1000)),
    frameBudgetMs: 16.67,
    withinBudget: msPerStep < 16.67,
    finalScore: world.score,
    finalState: world.state
  };
}
