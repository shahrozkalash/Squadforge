import { parentPort } from 'node:worker_threads';
import { applyFilterToImageRows, compositeRows } from './imageCore.js';
import type { BandJob, BandResult } from './acceleration.js';

/**
 * Phase 51: the parallel CPU provider's worker entry.
 *
 * One-shot protocol: the main thread spawns one worker per row band,
 * posts exactly one `BandJob`, and this worker computes that band
 * with the same banded engine functions the serial path is built
 * from (`compositeRows` / `applyFilterToImageRows` in imageCore.ts),
 * posts the band's pixels back as a transferred buffer, and is then
 * terminated by the main thread. Errors are reported, never hidden:
 * a failed band fails the whole operation on the main thread.
 *
 * The worker loads through the same tsx loader as the main thread
 * (worker_threads inherits execArgv), which is how this .ts entry
 * runs under `tsx --test` and `tsx server.ts` without a build step.
 */

if (!parentPort) {
  throw new Error('accelerationWorker.ts must run as a worker thread, not on the main thread');
}

const port = parentPort;

port.on('message', (job: BandJob) => {
  try {
    const img =
      job.kind === 'composite'
        ? compositeRows(job.project, job.y0, job.y1)
        : applyFilterToImageRows(job.image, job.filterId, job.params, job.y0, job.y1);
    // Copy into a fresh exact-size array so the buffer can be transferred.
    const data = new Uint8ClampedArray(img.data);
    const result: BandResult = { ok: true, width: img.width, height: img.height, data };
    port.postMessage(result, [data.buffer]);
  } catch (err) {
    const result: BandResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    port.postMessage(result);
  }
});
