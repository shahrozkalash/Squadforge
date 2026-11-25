import { auditLog } from '../auditLog.js';
import { WorkerHealthSnapshot } from './executionBackend.js';

export interface WorkerHealthMonitorOptions {
  intervalMs: number;
  /** Resolves when the worker is healthy; throws otherwise. */
  probe: () => Promise<void>;
  /** Runs when the worker recovers after having been unhealthy (e.g. an orphan sweep). */
  onRegained?: () => Promise<void>;
}

/**
 * Phase 32: periodic worker availability monitoring.
 *
 * The monitor owns only the transition bookkeeping: it probes on an
 * interval, audits health loss and regain exactly once per transition,
 * and invokes the recovery callback after a regain. It never starts
 * execution itself and never treats an unprobed worker as healthy.
 */
export class WorkerHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private state: WorkerHealthSnapshot['state'] = 'unknown';
  private lastCheckedAt?: number;
  private lastError?: string;
  private consecutiveFailures = 0;
  private checking = false;

  constructor(private readonly options: WorkerHealthMonitorOptions) {}

  snapshot(): WorkerHealthSnapshot {
    return {
      state: this.state,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures
    };
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.options.probe();
      const regained = this.state === 'unhealthy';
      this.state = 'healthy';
      this.lastCheckedAt = Date.now();
      this.lastError = undefined;
      this.consecutiveFailures = 0;
      if (regained) {
        auditLog('execution.worker.health_regained', { outcome: 'recovered' });
        await this.options.onRegained?.().catch(() => undefined);
      }
    } catch (err: any) {
      const lost = this.state === 'healthy';
      this.state = 'unhealthy';
      this.lastCheckedAt = Date.now();
      this.lastError = err.message || 'Worker probe failed';
      this.consecutiveFailures++;
      if (lost || this.consecutiveFailures === 1) {
        auditLog('execution.worker.health_lost', {
          outcome: 'unhealthy',
          details: { error: this.lastError, consecutiveFailures: this.consecutiveFailures }
        });
      }
    } finally {
      this.checking = false;
    }
  }
}
