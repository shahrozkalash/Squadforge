import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ExportResult, ExportSettings, MediaAsset, SerializedVideoProject, VideoProject } from './types.js';
import { exportVideo } from './videoExporter.js';
import { deserializeVideoProject, serializeVideoProject } from './timeline.js';

/**
 * Phase 30: background render jobs with safe recovery.
 *
 * Jobs run one at a time (memory stays bounded for long videos), report
 * real progress from ffmpeg's own time output, can be cancelled, and
 * persist to `jobs.json` in the jobs directory after every transition.
 * On load, any job a previous process left in `queued`/`running` is
 * marked `interrupted` — its output file is NEVER trusted as a finished
 * render — and can be retried from the serialized project stored with
 * the job.
 */

export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface RenderJob {
  id: string;
  buildId: string;
  projectName: string;
  outputPath: string;
  settings: ExportSettings;
  status: RenderJobStatus;
  /** 0..1, from ffmpeg's reported elapsed time over the expected duration. */
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  encoderUsed?: string;
  outputBytes?: number;
  durationSec?: number;
  notes?: string[];
  outputDeleted?: boolean;
  /** Stored so an interrupted job can be retried after a restart. */
  serializedProject: SerializedVideoProject;
}

interface PersistedJobs {
  version: 1;
  jobs: RenderJob[];
}

export class RenderJobManager {
  private jobs = new Map<string, RenderJob>();
  private controllers = new Map<string, AbortController>();
  private running = false;
  private loaded = false;
  /** Phase 4: persists are serialized through this chain (see persist()). */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly jobsDir: string) {}

  private get storePath(): string {
    return path.join(this.jobsDir, 'jobs.json');
  }

  /** Load persisted jobs; unfinished ones become `interrupted`. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.promises.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedJobs;
      let changed = false;
      for (const job of parsed.jobs ?? []) {
        if (job.status === 'queued' || job.status === 'running') {
          job.status = 'interrupted';
          job.error = 'The render process stopped before this job finished. The partial output is not a valid export; retry the job to render it again.';
          job.finishedAt = job.finishedAt ?? new Date().toISOString();
          changed = true;
        }
        this.jobs.set(job.id, job);
      }
      if (changed) await this.persist();
    } catch {
      // No store yet (or unreadable): start empty rather than guess.
    }
  }

  /**
   * Persist the job store. Phase 4 reliability fix: persists are
   * SERIALIZED through a chain and each write uses a UNIQUE tmp
   * name. Previously every caller wrote the same `jobs.json.tmp`
   * and renamed it over the store; two overlapping persists (a
   * submit's awaited persist, a running job's start/finish persist,
   * a cancel's fire-and-forget persist) interleaved their
   * write/rename steps, and the second rename failed with ENOENT
   * because the first had already moved the tmp file away — the
   * failure main CI run #173 hit in the Phase 30 jobs test. The
   * snapshot is taken when the write actually runs, so a queued
   * persist always stores the latest state.
   */
  private persist(): Promise<void> {
    const run = this.persistChain.then(() => this.writeStore());
    // The chain itself never rejects (one failed write must not
    // wedge every later persist); the caller of THIS persist still
    // sees its own failure through `run`.
    this.persistChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async writeStore(): Promise<void> {
    await fs.promises.mkdir(this.jobsDir, { recursive: true });
    const data: PersistedJobs = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmp, this.storePath);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async submit(input: {
    buildId: string;
    project: VideoProject;
    mediaAssets: Map<string, MediaAsset>;
    settings: ExportSettings;
    outputPath: string;
  }): Promise<RenderJob> {
    await this.load();
    const job: RenderJob = {
      id: randomUUID(),
      buildId: input.buildId,
      projectName: input.project.name,
      outputPath: input.outputPath,
      settings: input.settings,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      serializedProject: serializeVideoProject(input.project, input.mediaAssets)
    };
    this.jobs.set(job.id, job);
    await this.persist();
    void this.pump();
    return job;
  }

  get(id: string): RenderJob | undefined {
    return this.jobs.get(id);
  }

  list(buildId?: string): RenderJob[] {
    return [...this.jobs.values()]
      .filter((j) => !buildId || j.buildId === buildId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Finished jobs (the export history), newest first. */
  history(buildId?: string): RenderJob[] {
    return this.list(buildId).filter((j) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status));
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.error = 'Cancelled before the render started.';
      void this.persist();
      return true;
    }
    if (job.status === 'running') {
      this.controllers.get(id)?.abort();
      return true;
    }
    return false;
  }

  /** Re-run a failed/cancelled/interrupted job from its stored project. */
  async retry(id: string): Promise<RenderJob> {
    await this.load();
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Render job ${id} not found`);
    if (job.status === 'queued' || job.status === 'running') throw new Error(`Render job ${id} is already ${job.status}`);
    job.status = 'queued';
    job.progress = 0;
    job.error = undefined;
    job.finishedAt = undefined;
    job.startedAt = undefined;
    job.outputDeleted = false;
    await this.persist();
    void this.pump();
    return job;
  }

  /** Delete a job's output file (the history record is kept). */
  async deleteOutput(id: string): Promise<RenderJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Render job ${id} not found`);
    if (job.status === 'running' || job.status === 'queued') throw new Error('Cannot delete the output of an active job');
    await fs.promises.rm(job.outputPath, { force: true });
    job.outputDeleted = true;
    await this.persist();
    return job;
  }

  /** Test/shutdown hook: wait until no job is queued or running. */
  async whenIdle(timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = [...this.jobs.values()].some((j) => j.status === 'queued' || j.status === 'running');
      if (!active) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Render jobs did not become idle in time');
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = [...this.jobs.values()]
          .filter((j) => j.status === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!next) break;
        await this.runJob(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: RenderJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    await this.persist();
    let result: ExportResult;
    try {
      const { project, mediaAssets } = deserializeVideoProject(job.serializedProject);
      result = await exportVideo(project, mediaAssets, job.settings, job.outputPath, {
        signal: controller.signal,
        onProgress: (fraction) => {
          job.progress = Math.max(job.progress, Math.min(1, fraction));
        }
      });
    } catch (e: any) {
      result = {
        status: 'failed',
        expectedDurationSec: 0,
        ffmpegLogTail: '',
        error: `Render job crashed: ${e?.message ?? String(e)}`
      };
    } finally {
      this.controllers.delete(job.id);
    }
    job.finishedAt = new Date().toISOString();
    job.encoderUsed = result.encoderUsed;
    job.notes = result.notes;
    if (result.status === 'success') {
      job.status = 'succeeded';
      job.progress = 1;
      job.outputBytes = result.outputBytes;
      job.durationSec = result.durationSec;
      job.error = undefined;
    } else if (result.status === 'cancelled') {
      job.status = 'cancelled';
      job.error = result.error;
    } else {
      job.status = 'failed';
      job.error = result.error ?? 'Render failed';
    }
    await this.persist();
  }
}
