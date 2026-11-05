// Runs in its own process, so slow checks never hold up the server. Project code is only read here.
import { DiagnosticCollector } from './diagnosticCollector.js';

process.on('message', (request: any) => {
  try {
    const result = DiagnosticCollector.collectStatic(request.buildId, request.files, request.contracts);
    process.send!({ id: request.id, result });
  } catch (err: any) {
    process.send!({ id: request.id, error: err.message || 'Checks failed' });
  }
});

process.on('disconnect', () => process.exit(0));
