import { ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DebugDiagnostic, DiagnosticCheck, ProjectContract, ProjectFile } from '../types.js';

const CHECK_TIMEOUT_MS = 120000;
const IDLE_EXIT_MS = 30000;
const WORKER_PATH = fileURLToPath(new URL('./staticCheckWorker.ts', import.meta.url));
const PASSED_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export interface StaticCheckResult {
  diagnostics: DebugDiagnostic[];
  checks: DiagnosticCheck[];
}

/** The worker gets no server secrets and no real database. */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', SQLITE_DB_PATH: ':memory:' };
  for (const name of PASSED_ENV) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

/**
 * One worker process runs checks in turn. Killing it is what makes a running check cancellable,
 * and a check that fails to finish is an error, never a pass.
 */
class StaticCheckRunner {
  private worker?: ChildProcess;
  private idleTimer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;

  private start(): ChildProcess {
    if (this.worker?.connected) return this.worker;
    const worker = fork(WORKER_PATH, [], {
      execArgv: ['--no-warnings', '--import', import.meta.resolve('tsx')],
      env: workerEnv(),
      silent: true
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    this.worker = worker;
    return worker;
  }

  private release(worker: ChildProcess): void {
    worker.unref();
    (worker.channel as any)?.unref?.();
    (worker.stdout as any)?.unref?.();
    (worker.stderr as any)?.unref?.();
    this.idleTimer = setTimeout(() => this.stop(worker), IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  private stop(worker: ChildProcess): void {
    worker.kill();
    if (this.worker === worker) this.worker = undefined;
  }

  private execute(buildId: string, files: ProjectFile[], contracts: ProjectContract[], signal?: AbortSignal) {
    return new Promise<StaticCheckResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Checks cancelled'));
      clearTimeout(this.idleTimer);

      const worker = this.start();
      worker.ref();
      (worker.channel as any)?.ref?.();
      const id = ++this.nextId;

      const done = (finish: () => void, keep: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        signal?.removeEventListener('abort', onAbort);
        if (keep) this.release(worker);
        else this.stop(worker);
        finish();
      };
      const onMessage = (message: any) => {
        if (message.id !== id) return;
        done(() => (message.error ? reject(new Error(message.error)) : resolve(message.result)), true);
      };
      const onExit = () => done(() => reject(new Error('The check process stopped unexpectedly')), false);
      const onAbort = () => done(() => reject(new Error('Checks cancelled')), false);
      const timer = setTimeout(() => done(() => reject(new Error('Checks timed out')), false), CHECK_TIMEOUT_MS);

      worker.on('message', onMessage);
      worker.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.send({ id, buildId, contracts, files: files.map(({ path, content }) => ({ path, content })) });
    });
  }

  run(buildId: string, files: ProjectFile[], contracts: ProjectContract[], signal?: AbortSignal): Promise<StaticCheckResult> {
    const task = this.queue.then(() => this.execute(buildId, files, contracts, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }
}

const runner = new StaticCheckRunner();

export function runStaticChecks(
  buildId: string,
  files: ProjectFile[],
  contracts: ProjectContract[] = [],
  signal?: AbortSignal
): Promise<StaticCheckResult> {
  return runner.run(buildId, files, contracts, signal);
}
