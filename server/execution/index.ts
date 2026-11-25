import { auditLog } from '../auditLog.js';
import { DisabledBackend } from './disabledBackend.js';
import { DockerBackend } from './dockerBackend.js';
import { ExecutionBackend } from './executionBackend.js';
import { ExecutionSessionManager, executionConfigFromEnv } from './executionSessionManager.js';
import { createPreviewServer } from './previewProxy.js';
import { PreviewSessionService, previewConfigFromEnv } from './previewSessionService.js';
import { WorkerHealthMonitor } from './workerHealth.js';
import { workerHealthIntervalMs } from './workerConfig.js';

const REAP_INTERVAL_MS = 30000;

function backendFromEnv(): ExecutionBackend {
  if (process.env.EXECUTION_BACKEND !== 'docker') return new DisabledBackend();
  try {
    const backend = new DockerBackend();
    const configError = backend.configurationError();
    if (configError) {
      // Fail closed at startup with the reason visible, instead of
      // serving an execution backend that cannot be trusted.
      console.error(`Execution backend disabled: ${configError}`);
      auditLog('execution.backend.init_failed', {
        outcome: 'disabled',
        details: { reason: configError }
      });
    }
    return backend;
  } catch (err: any) {
    const reason = `Project execution is disabled: ${err.message || 'the Docker worker could not be configured'}`;
    console.error(`Execution backend disabled: ${err.message}`);
    auditLog('execution.backend.init_failed', {
      outcome: 'disabled',
      details: { reason: err.message }
    });
    return new DisabledBackend(reason);
  }
}

export const executionManager = new ExecutionSessionManager(backendFromEnv(), executionConfigFromEnv());
export const previewService = new PreviewSessionService(executionManager, previewConfigFromEnv());

/** Starts the preview listener and cleanup loop. Does nothing when execution is disabled. */
export async function startExecutionServices(): Promise<() => void> {
  if (executionManager.backend.name === 'disabled') return () => undefined;

  await executionManager.reconcile().catch(err => console.error('Execution reconcile failed:', err.message));

  // Phase 32: clear worker resources no live session owns (crash orphans),
  // then keep watching worker health; a regain triggers another sweep.
  await executionManager.sweepOrphanedResources().catch(err =>
    console.error('Execution orphan sweep failed:', err.message)
  );

  let healthMonitor: WorkerHealthMonitor | null = null;
  if (executionManager.backend.name === 'docker') {
    healthMonitor = new WorkerHealthMonitor({
      intervalMs: workerHealthIntervalMs(),
      probe: () => executionManager.checkWorkerHealth(),
      onRegained: async () => {
        await executionManager.sweepOrphanedResources();
      }
    });
    executionManager.attachHealthMonitor(healthMonitor);
    healthMonitor.start();
  }

  const previewServer = previewService.config.baseDomain ? createPreviewServer(previewService) : null;
  previewServer?.listen(previewService.config.listenPort, '0.0.0.0');

  const timer = setInterval(() => {
    Promise.all([executionManager.reap(), previewService.reap()])
      .catch(err => console.error('Execution cleanup failed:', err.message));
  }, REAP_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    healthMonitor?.stop();
    previewServer?.close();
  };
}
