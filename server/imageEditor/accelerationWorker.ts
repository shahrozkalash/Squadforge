import { parentPort } from 'node:worker_threads';
import { applyFilterToImageRows, compositeRows } from './imageCore.js';
import type { BandJob, BandResult } from './acceleration.js';

/**
 * Phase 51: the parallel CPU provider's worker entry.
 *
 * Protocol: the main thread posts `BandJob`s to this worker — since
 * Phase 59 from a persistent pool, so a worker answers job after
 * job (at most one in flight per worker; the protocol carries no
 * job ids). Each job is computed with the same banded engine
 * functions the serial path is built from (`compositeRows` /
 * `applyFilterToImageRows` in imageCore.ts) and the band's pixels
 * are posted back as a transferred buffer. Errors are reported,
 * never hidden: a failed band fails the whole operation on the
 * main thread.
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
