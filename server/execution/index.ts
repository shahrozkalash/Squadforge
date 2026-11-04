import { DisabledBackend } from './disabledBackend.js';
import { DockerBackend } from './dockerBackend.js';
import { ExecutionBackend } from './executionBackend.js';
import { ExecutionSessionManager, executionConfigFromEnv } from './executionSessionManager.js';
import { createPreviewServer } from './previewProxy.js';
import { PreviewSessionService, previewConfigFromEnv } from './previewSessionService.js';

const REAP_INTERVAL_MS = 30000;

function backendFromEnv(): ExecutionBackend {
  return process.env.EXECUTION_BACKEND === 'docker' ? new DockerBackend() : new DisabledBackend();
}

export const executionManager = new ExecutionSessionManager(backendFromEnv(), executionConfigFromEnv());
export const previewService = new PreviewSessionService(executionManager, previewConfigFromEnv());

/** Starts the preview listener and cleanup loop. Does nothing when execution is disabled. */
export async function startExecutionServices(): Promise<() => void> {
  if (executionManager.backend.name === 'disabled') return () => undefined;

  await executionManager.reconcile().catch(err => console.error('Execution reconcile failed:', err.message));

  const previewServer = previewService.config.baseDomain ? createPreviewServer(previewService) : null;
  previewServer?.listen(previewService.config.listenPort, '0.0.0.0');

  const timer = setInterval(() => {
    Promise.all([executionManager.reap(), previewService.reap()])
      .catch(err => console.error('Execution cleanup failed:', err.message));
  }, REAP_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    previewServer?.close();
  };
}
